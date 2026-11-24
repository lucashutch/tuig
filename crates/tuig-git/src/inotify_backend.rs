//! A Linux file watcher that never asks for open events.
//!
//! `notify` watches with `IN_OPEN` set. Every `git status` or `git fetch` that Tuig runs opens each directory and
//! many files, so the kernel queued one event per open and woke the watcher thread for it, only for the callback
//! to drop the event. A refresh in a repository with a few hundred directories cost thousands of wakeups. This
//! backend sets the mask Tuig needs: changes, not reads.

use crate::debug_log::debug_log_error;
use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask, Watches};
use std::collections::HashMap;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;

/// What the watcher thread reports.
#[derive(Debug)]
pub(crate) enum BackendEvent {
    /// Paths of changed entries. Empty when the kernel dropped events (queue overflow).
    Paths(Vec<PathBuf>),
    /// The watch failed and stopped. No event follows.
    Failed(notify::Error),
}

fn watch_mask() -> WatchMask {
    WatchMask::ATTRIB
        | WatchMask::CREATE
        | WatchMask::DELETE
        | WatchMask::CLOSE_WRITE
        | WatchMask::MODIFY
        | WatchMask::MOVED_FROM
        | WatchMask::MOVED_TO
        | WatchMask::DELETE_SELF
        | WatchMask::MOVE_SELF
}

/// `objects` and `logs` directly inside a `.git` directory.
fn is_unwatched_git_dir(dir: &Path) -> bool {
    dir.file_name()
        .is_some_and(|name| name == "objects" || name == "logs")
        && dir
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == ".git")
}

fn to_notify(error: io::Error, path: &Path) -> notify::Error {
    match error.raw_os_error() {
        Some(libc::ENOSPC) => notify::Error::new(notify::ErrorKind::MaxFilesWatch),
        _ if error.kind() == io::ErrorKind::NotFound => notify::Error::path_not_found(),
        _ => notify::Error::io(error),
    }
    .add_path(path.to_path_buf())
}

/// A running watch of one directory. Dropping it stops the thread.
pub(crate) struct InotifyWatcher {
    wake: OwnedFd,
    thread: Option<JoinHandle<()>>,
    /// Events the kernel delivered, for tests.
    #[cfg(test)]
    raw_events: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// Set when the thread finished the first walk, for tests.
    #[cfg(test)]
    walked: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}

impl InotifyWatcher {
    /// Watches `root`, and every directory below it when `recursive`. Fails when `root` cannot be watched. `sink`
    /// runs on the watcher thread.
    ///
    /// Only the root watch is added before this returns. The thread walks the tree below it, because a large work
    /// tree takes tens of milliseconds and this runs on the UI thread. Events in directories that are already
    /// watched queue in the kernel during the walk and are read after it. A change in a directory that the walk has
    /// not reached yet is not reported, as with a change made before the watch started. The app's periodic refresh
    /// covers it. A walk that fails, for example at the watch limit, sends `Failed`.
    pub(crate) fn start(
        root: &Path,
        recursive: bool,
        sink: impl Fn(BackendEvent) + Send + 'static,
    ) -> notify::Result<Self> {
        let inotify = Inotify::init().map_err(notify::Error::io)?;
        let mut state = State {
            watches: inotify.watches(),
            directories: HashMap::new(),
            recursive,
            root: root.to_path_buf(),
            limit_logged: false,
        };
        let descriptor = state
            .watches
            .add(root, watch_mask())
            .map_err(|error| to_notify(error, root))?;
        state.directories.insert(descriptor, root.to_path_buf());

        let (read, write) = pipe().map_err(notify::Error::io)?;
        #[cfg(test)]
        let raw_events = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        #[cfg(test)]
        let counter = raw_events.clone();
        #[cfg(test)]
        let walked = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        #[cfg(test)]
        let walk_done = walked.clone();
        let root = root.to_path_buf();
        let thread = std::thread::Builder::new()
            .name("tuig-watch".into())
            .spawn(move || {
                // The root is watched already, so the walk adds only the directories below it.
                let walk = if state.recursive {
                    state.add_tree(&root, &mut Vec::new(), true)
                } else {
                    Ok(())
                };
                #[cfg(test)]
                {
                    *walk_done.0.lock().unwrap() = true;
                    walk_done.1.notify_all();
                }
                let outcome = walk.and_then(|()| {
                    state.run(
                        inotify,
                        &read,
                        &sink,
                        #[cfg(test)]
                        &counter,
                    )
                });
                if let Err(error) = outcome {
                    sink(BackendEvent::Failed(to_notify(error, &root)));
                }
            })
            .map_err(notify::Error::io)?;
        Ok(Self {
            wake: write,
            thread: Some(thread),
            #[cfg(test)]
            raw_events,
            #[cfg(test)]
            walked,
        })
    }

    /// Blocks until the thread has watched the tree below the root.
    #[cfg(test)]
    fn wait_walked(&self) {
        let (done, changed) = &*self.walked;
        let mut done = done.lock().unwrap();
        while !*done {
            done = changed.wait(done).unwrap();
        }
    }

    #[cfg(test)]
    fn raw_events(&self) -> usize {
        self.raw_events.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Drop for InotifyWatcher {
    fn drop(&mut self) {
        // One byte makes the thread's poll return, and the thread ends.
        // SAFETY: `wake` is an open pipe end owned by this value.
        unsafe { libc::write(self.wake.as_raw_fd(), [1u8].as_ptr().cast(), 1) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: `fds` has room for the two descriptors that `pipe2` writes.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `pipe2` returned two new descriptors that nothing else owns.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

struct State {
    watches: Watches,
    directories: HashMap<WatchDescriptor, PathBuf>,
    recursive: bool,
    /// The directory the watch started on.
    root: PathBuf,
    /// Whether the watch limit was already logged, so a full limit logs once.
    limit_logged: bool,
}

impl State {
    /// Watches `dir`, then its subdirectories when the watch is recursive. `found` collects what the walk saw, for
    /// a directory that appeared after the watch started. A directory that vanishes during the walk is skipped.
    fn add_tree(&mut self, dir: &Path, found: &mut Vec<PathBuf>, is_root: bool) -> io::Result<()> {
        // Objects and logs change on every commit, and Tuig ignores them. Skipping them saves many watches.
        if !is_root && is_unwatched_git_dir(dir) {
            return Ok(());
        }
        let mask = if is_root {
            watch_mask()
        } else {
            watch_mask() | WatchMask::DONT_FOLLOW | WatchMask::ONLYDIR
        };
        match self.watches.add(dir, mask) {
            Ok(descriptor) => {
                self.directories.insert(descriptor, dir.to_path_buf());
            }
            Err(error) => {
                if is_root || error.raw_os_error() == Some(libc::ENOSPC) {
                    return Err(error);
                }
                // A subdirectory that vanished or cannot be read is skipped.
                return Ok(());
            }
        }
        if !self.recursive {
            return Ok(());
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Ok(());
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
            if !is_root {
                found.push(path.clone());
            }
            if is_dir {
                self.add_tree(&path, found, false)?;
            }
        }
        Ok(())
    }

    fn run(
        &mut self,
        mut inotify: Inotify,
        wake: &OwnedFd,
        sink: &impl Fn(BackendEvent),
        #[cfg(test)] counter: &std::sync::atomic::AtomicUsize,
    ) -> io::Result<()> {
        let mut buffer = [0u8; 32 * 1024];
        loop {
            let mut fds = [
                libc::pollfd {
                    fd: inotify.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: wake.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            // SAFETY: `fds` is an array of two initialised `pollfd`s.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if fds[1].revents != 0 {
                return Ok(());
            }
            loop {
                let events = match inotify.read_events(&mut buffer) {
                    Ok(events) => events,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => return Err(error),
                };
                let mut changed: Vec<PathBuf> = Vec::new();
                let mut overflow = false;
                let mut root_lost = false;
                for event in events {
                    #[cfg(test)]
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if event.mask.contains(EventMask::Q_OVERFLOW) {
                        overflow = true;
                        continue;
                    }
                    if event.mask.contains(EventMask::IGNORED) {
                        if self.directories.remove(&event.wd).as_deref()
                            == Some(self.root.as_path())
                        {
                            root_lost = true;
                        }
                        continue;
                    }
                    let Some(dir) = self.directories.get(&event.wd).cloned() else {
                        continue;
                    };
                    let path = match event.name {
                        Some(name) => dir.join(name),
                        None => dir,
                    };
                    let is_dir = event.mask.contains(EventMask::ISDIR);
                    if is_dir && event.mask.contains(EventMask::MOVED_FROM) {
                        self.forget_tree(&path);
                    }
                    if self.recursive
                        && is_dir
                        && event
                            .mask
                            .intersects(EventMask::CREATE | EventMask::MOVED_TO)
                    {
                        // Entries made before the watch existed would otherwise go unreported.
                        self.watch_new_directory(&path, &mut changed)?;
                    }
                    changed.push(path);
                }
                if overflow {
                    // Events were lost, so directories made in the gap are not watched yet.
                    self.recover_from_overflow()?;
                    // An empty report counts as a change of unknown paths.
                    sink(BackendEvent::Paths(Vec::new()));
                }
                if !changed.is_empty() {
                    sink(BackendEvent::Paths(changed));
                }
                if root_lost {
                    return Err(io::ErrorKind::NotFound.into());
                }
            }
        }
    }

    /// Watches a directory that appeared after the start. At the watch limit the directory stays unwatched, and
    /// the watcher keeps running, so the paths already found still reach the app.
    fn watch_new_directory(&mut self, path: &Path, changed: &mut Vec<PathBuf>) -> io::Result<()> {
        let result = self.add_tree(path, changed, false);
        self.tolerate_limit(result)
    }

    /// Turns a full watch limit into a logged warning. Other errors pass through.
    fn tolerate_limit(&mut self, result: io::Result<()>) -> io::Result<()> {
        match result {
            Err(error) if error.raw_os_error() == Some(libc::ENOSPC) => {
                if !self.limit_logged {
                    self.limit_logged = true;
                    debug_log_error(
                        "watch",
                        "watch limit reached, some directories are not watched",
                        &error,
                    );
                }
                Ok(())
            }
            other => other,
        }
    }

    /// Walks the tree again to watch directories that appeared while the kernel dropped events. A directory that
    /// is already watched keeps its descriptor, so the walk is safe to repeat.
    fn recover_from_overflow(&mut self) -> io::Result<()> {
        if !self.recursive {
            return Ok(());
        }
        let root = self.root.clone();
        let result = self.add_tree(&root, &mut Vec::new(), true);
        self.tolerate_limit(result)
    }

    /// Drops the watches at and below `path`, for a directory that moved away.
    fn forget_tree(&mut self, path: &Path) {
        let moved: Vec<WatchDescriptor> = self
            .directories
            .iter()
            .filter(|(_, dir)| dir.starts_with(path))
            .map(|(descriptor, _)| descriptor.clone())
            .collect();
        for descriptor in moved {
            self.directories.remove(&descriptor);
            let _ = self.watches.remove(descriptor);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::TempDir;
    use std::sync::mpsc;
    use std::time::Duration;

    fn watch(root: &Path, recursive: bool) -> (InotifyWatcher, mpsc::Receiver<BackendEvent>) {
        let (tx, rx) = mpsc::channel();
        let watcher = InotifyWatcher::start(root, recursive, move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        watcher.wait_walked();
        (watcher, rx)
    }

    fn next_paths(rx: &mpsc::Receiver<BackendEvent>, wanted: &Path) -> bool {
        next_paths_logged(rx, wanted, &mut Vec::new())
    }

    /// Like `next_paths`, and records every event received on the way in `seen` for assertion messages.
    fn next_paths_logged(
        rx: &mpsc::Receiver<BackendEvent>,
        wanted: &Path,
        seen: &mut Vec<String>,
    ) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(BackendEvent::Paths(paths)) if paths.iter().any(|path| path == wanted) => {
                    return true;
                }
                Ok(event) => seen.push(format!("{event:?}")),
                Err(_) => return false,
            }
        }
        false
    }

    #[test]
    fn reading_files_wakes_nothing_and_writing_one_does() {
        // Not the system temp directory: other processes there can add events that this test would count.
        let scratch = Path::new(
            option_env!("CARGO_TARGET_TMPDIR")
                .unwrap_or(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/tmp")),
        )
        .to_owned();
        std::fs::create_dir_all(&scratch).unwrap();
        let dir = TempDir::new_in(&scratch, "inotify-reads");
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/file.txt"), "one").unwrap();
        let (watcher, rx) = watch(root, true);

        // What `git status` does: list directories and read files.
        for _ in 0..20 {
            let _ = std::fs::read_dir(root.join("a/b")).unwrap().count();
            let _ = std::fs::read(root.join("a/b/file.txt")).unwrap();
        }
        std::thread::sleep(Duration::from_millis(300));
        let received: Vec<String> = rx.try_iter().map(|event| format!("{event:?}")).collect();
        assert_eq!(
            watcher.raw_events(),
            0,
            "a read reached the watcher, events: {received:?}"
        );
        assert!(received.is_empty(), "a read sent events: {received:?}");

        std::fs::write(root.join("a/b/file.txt"), "two").unwrap();
        let mut seen = Vec::new();
        assert!(
            next_paths_logged(&rx, &root.join("a/b/file.txt"), &mut seen),
            "the write was not reported, events: {seen:?}"
        );
        assert!(watcher.raw_events() > 0);
    }

    #[test]
    fn a_change_in_the_root_right_after_start_is_reported() {
        let dir = TempDir::new("inotify-early");
        let root = dir.path();
        for index in 0..200 {
            std::fs::create_dir_all(root.join(format!("d{index}/e"))).unwrap();
        }
        let (tx, rx) = mpsc::channel();
        let _watcher = InotifyWatcher::start(root, true, move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        // No wait for the walk: the root watch exists when `start` returns.
        std::fs::write(root.join("early.txt"), "x").unwrap();
        assert!(next_paths(&rx, &root.join("early.txt")));
    }

    #[test]
    fn a_directory_created_later_is_watched() {
        let dir = TempDir::new("inotify-new-dir");
        let root = dir.path();
        let (_watcher, rx) = watch(root, true);

        std::fs::create_dir(root.join("fresh")).unwrap();
        assert!(next_paths(&rx, &root.join("fresh")));
        std::fs::write(root.join("fresh/inside.txt"), "x").unwrap();
        assert!(next_paths(&rx, &root.join("fresh/inside.txt")));
    }

    #[test]
    fn a_non_recursive_watch_ignores_subdirectories() {
        let dir = TempDir::new("inotify-flat");
        let root = dir.path();
        std::fs::create_dir(root.join("sub")).unwrap();
        let (_watcher, rx) = watch(root, false);

        std::fs::write(root.join("sub/ignored.txt"), "x").unwrap();
        std::fs::write(root.join("seen.txt"), "x").unwrap();
        assert!(next_paths(&rx, &root.join("seen.txt")));
        while let Ok(event) = rx.try_recv() {
            if let BackendEvent::Paths(paths) = event {
                assert!(!paths.contains(&root.join("sub/ignored.txt")));
            }
        }
    }

    #[test]
    fn dropping_the_watcher_stops_the_thread() {
        let dir = TempDir::new("inotify-drop");
        let (watcher, rx) = watch(dir.path(), true);
        drop(watcher);
        // The sink is gone with the thread, so the channel is closed.
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(2)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
    }

    #[test]
    fn an_overflow_walk_watches_directories_made_while_events_were_lost() {
        let dir = TempDir::new("inotify-overflow");
        let root = dir.path();
        let inotify = Inotify::init().unwrap();
        let mut state = State {
            watches: inotify.watches(),
            directories: HashMap::new(),
            recursive: true,
            root: root.to_path_buf(),
            limit_logged: false,
        };
        state.add_tree(root, &mut Vec::new(), true).unwrap();
        // The kernel dropped the events for these, so `state` never saw them.
        std::fs::create_dir_all(root.join("lost/deeper")).unwrap();
        assert!(
            !state
                .directories
                .values()
                .any(|path| path.ends_with("lost"))
        );

        state.recover_from_overflow().unwrap();
        let watched: Vec<&PathBuf> = state.directories.values().collect();
        assert!(watched.contains(&&root.join("lost")));
        assert!(watched.contains(&&root.join("lost/deeper")));
        assert_eq!(watched.len(), 3, "a repeated walk added a duplicate watch");
    }

    #[test]
    fn a_deleted_root_fails_the_watch() {
        let dir = TempDir::new("inotify-root-gone");
        let root = dir.path().join("watched");
        std::fs::create_dir(&root).unwrap();
        let (_watcher, rx) = watch(&root, true);

        std::fs::remove_dir(&root).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let left = deadline
                .checked_duration_since(std::time::Instant::now())
                .expect("no Failed event after the root was deleted");
            if let Ok(BackendEvent::Failed(_)) = rx.recv_timeout(left) {
                break;
            }
        }
    }

    #[test]
    fn objects_and_logs_inside_a_git_dir_are_not_watched() {
        let dir = TempDir::new("inotify-git-dir");
        let root = dir.path();
        for sub in [
            ".git/objects/ab",
            ".git/logs/refs",
            ".git/refs/heads",
            "objects",
        ] {
            std::fs::create_dir_all(root.join(sub)).unwrap();
        }
        let inotify = Inotify::init().unwrap();
        let mut state = State {
            watches: inotify.watches(),
            directories: HashMap::new(),
            recursive: true,
            root: root.to_path_buf(),
            limit_logged: false,
        };
        state.add_tree(root, &mut Vec::new(), true).unwrap();
        let watched: Vec<&PathBuf> = state.directories.values().collect();
        assert!(watched.contains(&&root.join(".git")));
        assert!(watched.contains(&&root.join(".git/refs/heads")));
        assert!(watched.contains(&&root.join("objects")));
        assert!(!watched.contains(&&root.join(".git/objects")));
        assert!(!watched.contains(&&root.join(".git/logs")));
        assert!(!watched.contains(&&root.join(".git/logs/refs")));
    }
}
