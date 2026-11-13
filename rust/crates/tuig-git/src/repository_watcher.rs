//! Debounced file system watch of a repository's HEAD, index, refs, and work
//! tree. Port of `src/git/repository-watcher.ts`.
//!
//! The `notify` crate delivers events on its own thread. This module forwards
//! them over a channel to one worker thread that owns the debounce state, so
//! `on_change` and `on_error` run on that worker thread.
//!
//! Differences from the TypeScript code:
//! - `changed_at` is an [`Instant`] taken when the worker receives the event.
//! - Read-only events (open, close without write) are dropped. `inotify`
//!   reports them, and Node's `fs.watch` does not.
//! - [`RepositoryWatcher::close`] does not wait for a running `on_change`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::process::{RunOptions, own_git_active, run_git_with};
use crate::types::RepositoryWatchPaths;

/// Quiet time after the last event before a burst counts as one change.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(200);
/// A steady stream of events, such as a build, still reports once per window.
pub const WATCH_MAX_WAIT: Duration = Duration::from_millis(1000);
/// Delay before asking again when the caller cannot refresh yet.
pub const WATCH_RETRY: Duration = Duration::from_millis(1000);
/// Index writes this soon after a Tuig Git process exits are its own. Watch
/// events and process exits reach the worker in no fixed order.
const OWN_INDEX_WRITE_GRACE: Duration = Duration::from_millis(150);
/// Larger bursts skip the ignore check and always count as a change.
const IGNORE_CHECK_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy)]
pub struct RepositoryWatchOptions {
    pub debounce: Duration,
    pub max_wait: Duration,
    pub retry: Duration,
}

impl Default for RepositoryWatchOptions {
    fn default() -> Self {
        Self {
            debounce: WATCH_DEBOUNCE,
            max_wait: WATCH_MAX_WAIT,
            retry: WATCH_RETRY,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchEvent {
    Ignore,
    Metadata,
    Index,
    WorkTree,
}

/// Path relative to `parent` when `path` is `parent` or below it.
fn inside<'a>(parent: &Path, path: &'a Path) -> Option<&'a Path> {
    path.strip_prefix(parent).ok()
}

/// Sort one changed path into the Git state it can affect.
///
/// Only HEAD, the index, and refs change what Tuig shows. Objects, logs, and
/// lock files change on every commit and would only add noise. A `.git`
/// segment inside the work tree belongs to a nested repository or submodule.
pub fn classify_watch_event(paths: &RepositoryWatchPaths, path: &Path) -> WatchEvent {
    let git_dir = Path::new(&paths.git_dir);
    let common_dir = Path::new(&paths.common_dir);
    let work_tree = Path::new(&paths.work_tree);
    if let Some(name) = inside(git_dir, path) {
        if name == Path::new("index") {
            return WatchEvent::Index;
        }
        if name == Path::new("HEAD") {
            return WatchEvent::Metadata;
        }
    }
    if let Some(name) = inside(common_dir, path) {
        let name = name.to_string_lossy();
        if name.ends_with(".lock") {
            return WatchEvent::Ignore;
        }
        if name == "packed-refs" || name.starts_with("refs/") {
            return WatchEvent::Metadata;
        }
        return WatchEvent::Ignore;
    }
    if inside(git_dir, path).is_some() {
        return WatchEvent::Ignore;
    }
    if let Some(name) = inside(work_tree, path) {
        if name.as_os_str().is_empty() || name.components().any(|c| c.as_os_str() == ".git") {
            return WatchEvent::Ignore;
        }
        return WatchEvent::WorkTree;
    }
    WatchEvent::Ignore
}

/// Directories to watch. The work tree is watched recursively and already
/// covers a normal `.git` directory. A linked worktree or submodule keeps its
/// Git dir elsewhere, and refs can live in a shared common dir.
fn watch_targets(paths: &RepositoryWatchPaths) -> Vec<(PathBuf, RecursiveMode)> {
    let work_tree = Path::new(&paths.work_tree);
    let mut targets = vec![(work_tree.to_path_buf(), RecursiveMode::Recursive)];
    if inside(work_tree, Path::new(&paths.git_dir)).is_none() {
        targets.push((PathBuf::from(&paths.git_dir), RecursiveMode::NonRecursive));
    }
    if inside(work_tree, Path::new(&paths.common_dir)).is_none() {
        if paths.common_dir != paths.git_dir {
            targets.push((
                PathBuf::from(&paths.common_dir),
                RecursiveMode::NonRecursive,
            ));
        }
        targets.push((
            Path::new(&paths.common_dir).join("refs"),
            RecursiveMode::Recursive,
        ));
    }
    targets
}

/// True when Git ignores every one of the given work-tree paths.
fn all_ignored(work_tree: &str, names: &[String]) -> bool {
    // -z needs --stdin. A name Git still quotes, such as one with a newline,
    // fails the match and counts as a change.
    let mut args: Vec<String> = ["-c", "core.quotePath=false", "check-ignore", "--"]
        .map(String::from)
        .into();
    args.extend(names.iter().cloned());
    // Exit code 1 means none of the paths is ignored. Other failures, such as
    // a path inside a submodule, count as a change.
    let Ok(result) = run_git_with(&args, &RunOptions::in_dir(work_tree)) else {
        return false;
    };
    let ignored: HashSet<&str> = result.stdout.lines().filter(|l| !l.is_empty()).collect();
    names.iter().all(|name| ignored.contains(name.as_str()))
}

enum Message {
    /// Paths of one file system event. Empty when the backend named none.
    Paths(Vec<PathBuf>),
    Error(notify::Error),
    Close,
}

/// A running watch. Dropping it closes the watch.
pub struct RepositoryWatcher {
    closed: Arc<AtomicBool>,
    watchers: Arc<Mutex<Vec<RecommendedWatcher>>>,
    sender: Sender<Message>,
}

impl RepositoryWatcher {
    /// Stop watching. `on_change` is not called after this returns, though one
    /// call that already started can still finish.
    pub fn close(&self) {
        close_watch(&self.closed, &self.watchers);
        let _ = self.sender.send(Message::Close);
    }
}

impl Drop for RepositoryWatcher {
    fn drop(&mut self) {
        self.close();
    }
}

fn close_watch(closed: &AtomicBool, watchers: &Mutex<Vec<RecommendedWatcher>>) {
    closed.store(true, Ordering::SeqCst);
    watchers
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clear();
}

/// Debounce state, owned by the worker thread.
struct Burst {
    timer: Option<Instant>,
    started_at: Option<Instant>,
    changed_at: Instant,
    /// Work-tree paths in the burst, checked against .gitignore before
    /// reporting. `None` once the burst holds a change that always counts.
    work_tree_names: Option<HashSet<String>>,
}

/// Report changes to a repository's HEAD, index, refs, and work tree.
///
/// A burst of events is reported once, after it goes quiet. `on_change` gets
/// the time of the latest event in the burst and returns false when it cannot
/// refresh yet; the watcher then asks again later. Index writes made by Tuig's
/// own Git processes are dropped so a refresh cannot trigger another one.
///
/// Fails when a watch cannot start, for example when the inotify watch limit
/// is reached. `on_error` reports a watch that fails later; the watcher is
/// closed by then.
pub fn watch_repository(
    paths: RepositoryWatchPaths,
    on_change: impl Fn(Instant) -> bool + Send + 'static,
    on_error: impl Fn(notify::Error) + Send + 'static,
    options: RepositoryWatchOptions,
) -> notify::Result<RepositoryWatcher> {
    let (sender, receiver) = mpsc::channel::<Message>();
    let closed = Arc::new(AtomicBool::new(false));
    let watchers = Arc::new(Mutex::new(Vec::new()));

    let started = (|| {
        for (path, mode) in watch_targets(&paths) {
            let tx = Mutex::new(sender.clone());
            let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
                let message = match event {
                    // Reads do not change Git state. `inotify` also reports opens.
                    Ok(event) if matches!(event.kind, EventKind::Access(_)) => return,
                    Ok(event) => Message::Paths(event.paths),
                    Err(error) => Message::Error(error),
                };
                let _ = tx
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .send(message);
            })?;
            watcher.watch(&path, mode)?;
            watchers
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(watcher);
        }
        Ok(())
    })();
    if let Err(error) = started {
        close_watch(&closed, &watchers);
        return Err(error);
    }

    let worker_closed = closed.clone();
    let worker_watchers = watchers.clone();
    thread::spawn(move || {
        run_worker(
            &paths,
            &receiver,
            &worker_closed,
            &worker_watchers,
            &on_change,
            &on_error,
            options,
        );
    });
    Ok(RepositoryWatcher {
        closed,
        watchers,
        sender,
    })
}

fn run_worker(
    paths: &RepositoryWatchPaths,
    receiver: &mpsc::Receiver<Message>,
    closed: &AtomicBool,
    watchers: &Mutex<Vec<RecommendedWatcher>>,
    on_change: &dyn Fn(Instant) -> bool,
    on_error: &dyn Fn(notify::Error),
    options: RepositoryWatchOptions,
) {
    let mut burst = Burst {
        timer: None,
        started_at: None,
        changed_at: Instant::now(),
        work_tree_names: Some(HashSet::new()),
    };
    loop {
        let message = match burst.timer {
            Some(deadline) => {
                match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            None => match receiver.recv() {
                Ok(message) => Some(message),
                Err(_) => return,
            },
        };
        if closed.load(Ordering::SeqCst) {
            return;
        }
        match message {
            None => flush(paths, &mut burst, closed, on_change, options),
            Some(Message::Close) => return,
            Some(Message::Error(error)) => {
                close_watch(closed, watchers);
                on_error(error);
                return;
            }
            Some(Message::Paths(changed)) => {
                if changed.is_empty() {
                    // The backend named no file: treat it as a metadata change.
                    record(paths, &mut burst, WatchEvent::Metadata, None, options);
                }
                for path in &changed {
                    let kind = classify_watch_event(paths, path);
                    record(paths, &mut burst, kind, Some(path), options);
                }
            }
        }
    }
}

fn schedule(burst: &mut Burst, delay: Duration) {
    burst.timer = Some(Instant::now() + delay);
}

fn record(
    paths: &RepositoryWatchPaths,
    burst: &mut Burst,
    kind: WatchEvent,
    path: Option<&Path>,
    options: RepositoryWatchOptions,
) {
    if kind == WatchEvent::Ignore {
        return;
    }
    if kind == WatchEvent::Index && own_git_active(OWN_INDEX_WRITE_GRACE) {
        return;
    }
    let now = Instant::now();
    burst.changed_at = now;
    if kind != WatchEvent::WorkTree {
        burst.work_tree_names = None;
    } else if let Some(names) = &mut burst.work_tree_names {
        let name = path
            .and_then(|p| p.strip_prefix(&paths.work_tree).ok())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        names.insert(name);
        if names.len() > IGNORE_CHECK_LIMIT {
            burst.work_tree_names = None;
        }
    }
    let started = *burst.started_at.get_or_insert(now);
    let remaining = (started + options.max_wait).saturating_duration_since(now);
    schedule(burst, options.debounce.min(remaining));
}

fn flush(
    paths: &RepositoryWatchPaths,
    burst: &mut Burst,
    closed: &AtomicBool,
    on_change: &dyn Fn(Instant) -> bool,
    options: RepositoryWatchOptions,
) {
    burst.timer = None;
    let names = burst.work_tree_names.take();
    burst.started_at = None;
    burst.work_tree_names = Some(HashSet::new());
    if let Some(names) = names
        && !names.is_empty()
    {
        let names: Vec<String> = names.into_iter().collect();
        if all_ignored(&paths.work_tree, &names) {
            return;
        }
    }
    if closed.load(Ordering::SeqCst) {
        return;
    }
    if on_change(burst.changed_at) {
        return;
    }
    burst.work_tree_names = None;
    burst.started_at.get_or_insert_with(Instant::now);
    if burst.timer.is_none() {
        schedule(burst, options.retry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::run_git;
    use crate::test_util::TempDir;
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::AtomicUsize;

    fn paths(work: &str, git: &str, common: &str) -> RepositoryWatchPaths {
        RepositoryWatchPaths {
            work_tree: work.into(),
            git_dir: git.into(),
            common_dir: common.into(),
        }
    }

    #[test]
    fn classifies_paths_by_the_git_state_they_affect() {
        use WatchEvent::*;
        let normal = paths("/r", "/r/.git", "/r/.git");
        let cases = [
            ("/r/.git/index", Index),
            ("/r/.git/HEAD", Metadata),
            ("/r/.git/packed-refs", Metadata),
            ("/r/.git/refs/heads/main", Metadata),
            ("/r/.git/refs", Ignore),
            ("/r/.git/refs/heads/main.lock", Ignore),
            ("/r/.git/index.lock", Ignore),
            ("/r/.git/objects/ab/cdef", Ignore),
            ("/r/.git/logs/HEAD", Ignore),
            ("/r/src/main.rs", WorkTree),
            ("/r/sub/.git/index", Ignore),
            ("/r", Ignore),
            ("/elsewhere/file", Ignore),
        ];
        for (path, expected) in cases {
            assert_eq!(
                classify_watch_event(&normal, Path::new(path)),
                expected,
                "{path}"
            );
        }

        // A linked worktree: HEAD and index in a private Git dir, refs in the common dir.
        let linked = paths("/w/feature", "/r/.git/worktrees/feature", "/r/.git");
        assert_eq!(
            classify_watch_event(&linked, Path::new("/r/.git/worktrees/feature/index")),
            Index
        );
        assert_eq!(
            classify_watch_event(&linked, Path::new("/r/.git/worktrees/feature/HEAD")),
            Metadata
        );
        assert_eq!(
            classify_watch_event(&linked, Path::new("/r/.git/refs/heads/feature")),
            Metadata
        );
        assert_eq!(
            classify_watch_event(&linked, Path::new("/w/feature/a.txt")),
            WorkTree
        );
    }

    #[test]
    fn watches_outside_dirs_only_for_linked_worktrees() {
        let normal = watch_targets(&paths("/r", "/r/.git", "/r/.git"));
        assert_eq!(normal.len(), 1);
        let linked = watch_targets(&paths("/w", "/r/.git/worktrees/w", "/r/.git"));
        let dirs: Vec<_> = linked.iter().map(|(p, _)| p.to_str().unwrap()).collect();
        assert_eq!(
            dirs,
            ["/w", "/r/.git/worktrees/w", "/r/.git", "/r/.git/refs"]
        );
    }

    const OPTIONS: RepositoryWatchOptions = RepositoryWatchOptions {
        debounce: Duration::from_millis(300),
        max_wait: Duration::from_secs(3),
        retry: Duration::from_millis(200),
    };
    /// Long enough for a debounced report and the ignore check to land.
    const SETTLE: Duration = Duration::from_millis(1500);
    const TIMEOUT: Duration = Duration::from_secs(20);

    /// Runs Git the way another terminal would, outside Tuig's process count.
    fn external_git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.com",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn repository() -> TempDir {
        let dir = TempDir::new("tuig-watch");
        let root = dir.path();
        external_git(root, &["init", "-q", "-b", "main"]);
        fs::write(root.join(".gitignore"), "build/\n").unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        external_git(root, &["add", "."]);
        external_git(root, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn watch_paths(dir: &Path) -> RepositoryWatchPaths {
        let rev = |flag: &str| {
            let out = external_git(dir, &["rev-parse", "--path-format=absolute", flag]);
            fs::canonicalize(out)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        RepositoryWatchPaths {
            work_tree: rev("--show-toplevel"),
            git_dir: rev("--absolute-git-dir"),
            common_dir: rev("--git-common-dir"),
        }
    }

    struct Watch {
        calls: Arc<AtomicUsize>,
        _watcher: RepositoryWatcher,
    }

    impl Watch {
        fn count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    fn watch(dir: &Path, on_change: impl Fn() -> bool + Send + 'static) -> Watch {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let watcher = watch_repository(
            watch_paths(dir),
            move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
                on_change()
            },
            |error| panic!("watch failed: {error}"),
            OPTIONS,
        )
        .unwrap();
        Watch {
            calls,
            _watcher: watcher,
        }
    }

    fn wait_until(what: &str, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_commit_from_another_terminal_is_reported_once() {
        let repo = repository();
        let root = repo.path();
        let w = watch(root, || true);

        fs::write(root.join("a.txt"), "changed\n").unwrap();
        fs::write(root.join("b.txt"), "new\n").unwrap();
        external_git(root, &["add", "."]);
        external_git(root, &["commit", "-q", "-m", "second"]);

        wait_until("the commit report", || w.count() >= 1);
        thread::sleep(SETTLE);
        assert_eq!(w.count(), 1);
    }

    #[test]
    fn file_edits_are_reported_unless_git_ignores_them() {
        let repo = repository();
        let root = repo.path();
        let w = watch(root, || true);

        fs::create_dir(root.join("build")).unwrap();
        fs::write(root.join("build/out.js"), "generated\n").unwrap();
        thread::sleep(SETTLE);
        assert_eq!(w.count(), 0);

        fs::write(root.join("a.txt"), "edited\n").unwrap();
        wait_until("the edit report", || w.count() >= 1);
        thread::sleep(SETTLE);
        assert_eq!(w.count(), 1);
    }

    #[test]
    fn index_writes_from_tuigs_own_git_reads_do_not_report_a_change() {
        let repo = repository();
        let root = repo.path();
        // A stat-only change makes the next `git diff` rewrite the index.
        let future = std::time::SystemTime::now() + Duration::from_secs(86_400);
        fs::File::options()
            .write(true)
            .open(root.join("a.txt"))
            .unwrap()
            .set_modified(future)
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        let w = watch(root, || true);

        run_git(&["diff"], Some(root)).unwrap();
        thread::sleep(SETTLE);

        assert_eq!(w.count(), 0);
    }

    #[test]
    fn a_linked_worktree_sees_ref_updates_in_the_shared_common_dir() {
        let repo = repository();
        let root = repo.path();
        let holder = TempDir::new("tuig-watch-linked");
        let linked = holder.path().join("feature");
        external_git(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                linked.to_str().unwrap(),
            ],
        );
        external_git(&linked, &["commit", "-q", "--allow-empty", "-m", "feature"]);
        let w = watch(&linked, || true);
        thread::sleep(Duration::from_millis(100));

        // Branch refs live in the main checkout's .git, outside the linked tree.
        external_git(root, &["update-ref", "refs/heads/feature", "main"]);

        wait_until("the ref report", || w.count() >= 1);
        thread::sleep(SETTLE);
        assert_eq!(w.count(), 1);
    }

    #[test]
    fn a_change_the_caller_cannot_take_yet_is_reported_again() {
        let repo = repository();
        let root = repo.path();
        let ready = Arc::new(AtomicBool::new(false));
        let accepted = Arc::new(AtomicUsize::new(0));
        let (flag, took) = (ready.clone(), accepted.clone());
        let w = watch(root, move || {
            let ok = flag.load(Ordering::SeqCst);
            if ok {
                took.fetch_add(1, Ordering::SeqCst);
            }
            ok
        });

        fs::write(root.join("a.txt"), "edited\n").unwrap();
        wait_until("the first refused report", || w.count() >= 1);
        ready.store(true, Ordering::SeqCst);
        wait_until("a report the caller accepts", || {
            accepted.load(Ordering::SeqCst) >= 1
        });
        let total = w.count();
        thread::sleep(SETTLE);

        // Once accepted, the burst is over: no further asks.
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
        assert_eq!(w.count(), total);
    }

    #[test]
    fn a_closed_watcher_reports_nothing() {
        let repo = repository();
        let root = repo.path();
        let w = watch(root, || true);

        w._watcher.close();
        fs::write(root.join("a.txt"), "edited\n").unwrap();
        external_git(root, &["commit", "-q", "-am", "edit"]);
        thread::sleep(SETTLE);

        assert_eq!(w.count(), 0);
    }
}
