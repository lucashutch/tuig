//! Debounced file system watch of a repository's HEAD, index, refs, and work
//! tree. Port of `src/git/repository-watcher.ts`.
//!
//! The `notify` crate delivers events on its own thread. Its callback sends
//! them into an unbounded tokio channel. One tokio task owns the debounce
//! state and the timers, and sends each report as a [`WatchEvent`] into the
//! receiver that [`watch_repository`] returns.
//!
//! Differences from the TypeScript code:
//! - [`watch_repository`] must run inside a Tokio runtime. It spawns the task.
//! - `changed_at` is an [`Instant`] taken when the task receives the event.
//! - Read-only events (open, close without write) are dropped. `inotify`
//!   reports them, and Node's `fs.watch` does not.
//! - Reports go into a channel instead of callbacks. TypeScript's `onChange`
//!   returns false when the caller cannot refresh yet and the watcher asks
//!   again later. A channel cannot answer, so the receiver keeps that retry.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::process::{RunOptions, own_git_active, run_git_with};
use crate::types::RepositoryWatchPaths;

/// Quiet time after the last event before a burst counts as one change.
pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(200);
/// A steady stream of events, such as a build, still reports once per window.
pub const WATCH_MAX_WAIT: Duration = Duration::from_millis(1000);
/// Index writes this soon after a Tuig Git process exits are its own. Watch
/// events and process exits reach the worker in no fixed order.
const OWN_INDEX_WRITE_GRACE: Duration = Duration::from_millis(150);
/// Larger bursts skip the ignore check and always count as a change.
const IGNORE_CHECK_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy)]
pub struct RepositoryWatchOptions {
    pub debounce: Duration,
    pub max_wait: Duration,
}

impl Default for RepositoryWatchOptions {
    fn default() -> Self {
        Self {
            debounce: WATCH_DEBOUNCE,
            max_wait: WATCH_MAX_WAIT,
        }
    }
}

/// What a watch reports through its channel.
#[derive(Debug)]
pub enum WatchEvent {
    /// A burst of changes went quiet. `at` is the time of its latest event.
    Changed { at: Instant },
    /// The watch failed and closed itself. No event follows.
    Failed(notify::Error),
}

/// The Git state that one changed path can affect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchKind {
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
pub fn classify_watch_event(paths: &RepositoryWatchPaths, path: &Path) -> WatchKind {
    let git_dir = Path::new(&paths.git_dir);
    let common_dir = Path::new(&paths.common_dir);
    let work_tree = Path::new(&paths.work_tree);
    if let Some(name) = inside(git_dir, path) {
        if name == Path::new("index") {
            return WatchKind::Index;
        }
        if name == Path::new("HEAD") {
            return WatchKind::Metadata;
        }
    }
    if let Some(name) = inside(common_dir, path) {
        let name = name.to_string_lossy();
        if name.ends_with(".lock") {
            return WatchKind::Ignore;
        }
        if name == "packed-refs" || name.starts_with("refs/") {
            return WatchKind::Metadata;
        }
        return WatchKind::Ignore;
    }
    if inside(git_dir, path).is_some() {
        return WatchKind::Ignore;
    }
    if let Some(name) = inside(work_tree, path) {
        if name.as_os_str().is_empty() || name.components().any(|c| c.as_os_str() == ".git") {
            return WatchKind::Ignore;
        }
        return WatchKind::WorkTree;
    }
    WatchKind::Ignore
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
async fn all_ignored(work_tree: &str, names: &[String]) -> bool {
    // -z needs --stdin. A name Git still quotes, such as one with a newline,
    // fails the match and counts as a change.
    let mut args: Vec<String> = ["-c", "core.quotePath=false", "check-ignore", "--"]
        .map(String::from)
        .into();
    args.extend(names.iter().cloned());
    // Exit code 1 means none of the paths is ignored. Other failures, such as
    // a path inside a submodule, count as a change.
    let Ok(result) = run_git_with(&args, &RunOptions::in_dir(work_tree)).await else {
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
    sender: UnboundedSender<Message>,
}

impl RepositoryWatcher {
    /// Stop watching. At most one report that was already in flight may
    /// arrive after this returns. The receiver's owner discards it, for
    /// example with a generation check.
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

/// Debounce state, owned by the worker task.
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
/// A burst of events is reported once, after it goes quiet, as
/// [`WatchEvent::Changed`] with the time of the latest event in the burst.
/// Index writes made by Tuig's own Git processes are dropped so a refresh
/// cannot trigger another one. The receiver ends when the watcher closes.
///
/// Fails when a watch cannot start, for example when the inotify watch limit
/// is reached. A watch that fails later sends [`WatchEvent::Failed`]; the
/// watcher is closed by then.
pub fn watch_repository(
    paths: RepositoryWatchPaths,
    options: RepositoryWatchOptions,
) -> notify::Result<(RepositoryWatcher, UnboundedReceiver<WatchEvent>)> {
    let (events, reports) = mpsc::unbounded_channel::<WatchEvent>();
    let (sender, receiver) = mpsc::unbounded_channel::<Message>();
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
    tokio::spawn(async move {
        run_worker(
            &paths,
            receiver,
            &worker_closed,
            &worker_watchers,
            &events,
            options,
        )
        .await;
    });
    Ok((
        RepositoryWatcher {
            closed,
            watchers,
            sender,
        },
        reports,
    ))
}

async fn run_worker(
    paths: &RepositoryWatchPaths,
    mut receiver: UnboundedReceiver<Message>,
    closed: &AtomicBool,
    watchers: &Mutex<Vec<RecommendedWatcher>>,
    events: &UnboundedSender<WatchEvent>,
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
                tokio::select! {
                    message = receiver.recv() => match message {
                        Some(message) => Some(message),
                        None => return,
                    },
                    () = tokio::time::sleep_until(deadline.into()) => None,
                }
            }
            None => match receiver.recv().await {
                Some(message) => Some(message),
                None => return,
            },
        };
        if closed.load(Ordering::SeqCst) {
            return;
        }
        match message {
            None => flush(paths, &mut burst, closed, events).await,
            Some(Message::Close) => return,
            Some(Message::Error(error)) => {
                close_watch(closed, watchers);
                let _ = events.send(WatchEvent::Failed(error));
                return;
            }
            Some(Message::Paths(changed)) => {
                if changed.is_empty() {
                    // The backend named no file: treat it as a metadata change.
                    record(paths, &mut burst, WatchKind::Metadata, None, options);
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
    kind: WatchKind,
    path: Option<&Path>,
    options: RepositoryWatchOptions,
) {
    if kind == WatchKind::Ignore {
        return;
    }
    if kind == WatchKind::Index && own_git_active(OWN_INDEX_WRITE_GRACE) {
        return;
    }
    let now = Instant::now();
    burst.changed_at = now;
    if kind != WatchKind::WorkTree {
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

async fn flush(
    paths: &RepositoryWatchPaths,
    burst: &mut Burst,
    closed: &AtomicBool,
    events: &UnboundedSender<WatchEvent>,
) {
    burst.timer = None;
    let names = burst.work_tree_names.take();
    burst.started_at = None;
    burst.work_tree_names = Some(HashSet::new());
    if let Some(names) = names
        && !names.is_empty()
    {
        let names: Vec<String> = names.into_iter().collect();
        if all_ignored(&paths.work_tree, &names).await {
            return;
        }
    }
    if closed.load(Ordering::SeqCst) {
        return;
    }
    let _ = events.send(WatchEvent::Changed {
        at: burst.changed_at,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::run_git;
    use crate::test_util::TempDir;
    use std::fs;
    use std::process::Command;
    use std::sync::atomic::AtomicUsize;
    use tokio::time::sleep;

    fn paths(work: &str, git: &str, common: &str) -> RepositoryWatchPaths {
        RepositoryWatchPaths {
            work_tree: work.into(),
            git_dir: git.into(),
            common_dir: common.into(),
        }
    }

    #[test]
    fn classifies_paths_by_the_git_state_they_affect() {
        use WatchKind::*;
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

    const OPTIONS: RepositoryWatchOptions = RepositoryWatchOptions {
        debounce: Duration::from_millis(300),
        max_wait: Duration::from_secs(3),
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
        failure: Arc<Mutex<Option<String>>>,
        _watcher: RepositoryWatcher,
    }

    impl Watch {
        /// Panics on the test thread when the watch failed, so the test shows the real error.
        fn count(&self) -> usize {
            if let Some(error) = self.failure.lock().unwrap().as_ref() {
                panic!("watch failed: {error}");
            }
            self.calls.load(Ordering::SeqCst)
        }
    }

    /// Counts the reports a watch sends. A failure is stored and `Watch::count` panics with it.
    fn watch(dir: &Path) -> Watch {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let failure = Arc::new(Mutex::new(None));
        let failed = failure.clone();
        let (watcher, mut events) = watch_repository(watch_paths(dir), OPTIONS).unwrap();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    WatchEvent::Changed { .. } => counter.fetch_add(1, Ordering::SeqCst),
                    WatchEvent::Failed(error) => {
                        *failed.lock().unwrap() = Some(error.to_string());
                        0
                    }
                };
            }
        });
        Watch {
            calls,
            failure,
            _watcher: watcher,
        }
    }

    async fn wait_until(what: &str, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn a_commit_from_another_terminal_is_reported_once() {
        let repo = repository();
        let root = repo.path();
        let w = watch(root);

        fs::write(root.join("a.txt"), "changed\n").unwrap();
        fs::write(root.join("b.txt"), "new\n").unwrap();
        external_git(root, &["add", "."]);
        external_git(root, &["commit", "-q", "-m", "second"]);

        wait_until("the commit report", || w.count() >= 1).await;
        sleep(SETTLE).await;
        assert_eq!(w.count(), 1);
    }

    #[tokio::test]
    async fn file_edits_are_reported_unless_git_ignores_them() {
        let repo = repository();
        let root = repo.path();
        let w = watch(root);

        fs::create_dir(root.join("build")).unwrap();
        fs::write(root.join("build/out.js"), "generated\n").unwrap();
        sleep(SETTLE).await;
        assert_eq!(w.count(), 0);

        fs::write(root.join("a.txt"), "edited\n").unwrap();
        wait_until("the edit report", || w.count() >= 1).await;
        sleep(SETTLE).await;
        assert_eq!(w.count(), 1);
    }

    #[tokio::test]
    async fn index_writes_from_tuigs_own_git_reads_do_not_report_a_change() {
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
        sleep(Duration::from_millis(50)).await;
        let w = watch(root);

        run_git(&["diff"], Some(root)).await.unwrap();
        sleep(SETTLE).await;

        assert_eq!(w.count(), 0);
    }

    #[tokio::test]
    async fn a_linked_worktree_sees_ref_updates_in_the_shared_common_dir() {
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
        let w = watch(&linked);
        sleep(Duration::from_millis(100)).await;

        // Branch refs live in the main checkout's .git, outside the linked tree.
        external_git(root, &["update-ref", "refs/heads/feature", "main"]);

        wait_until("the ref report", || w.count() >= 1).await;
        sleep(SETTLE).await;
        assert_eq!(w.count(), 1);
    }
}
