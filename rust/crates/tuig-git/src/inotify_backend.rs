//! A Linux file watcher that never asks for open events.
//!
//! `notify` watches with `IN_OPEN` set. Every `git status` or `git fetch` that Tuig runs opens each directory and
//! many files, so the kernel queued one event per open and woke the watcher thread for it, only for the callback
//! to drop the event. A refresh in a repository with a few hundred directories cost thousands of wakeups. This
//! backend sets the mask Tuig needs: changes, not reads.

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
}

impl InotifyWatcher {
    /// Watches `root`, and every directory below it when `recursive`. Fails when a watch cannot be added, for
    /// example when the inotify watch limit is reached. `sink` runs on the watcher thread.
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
        };
        state
            .add_tree(root, &mut Vec::new(), true)
            .map_err(|error| to_notify(error, root))?;

        let (read, write) = pipe().map_err(notify::Error::io)?;
        #[cfg(test)]
        let raw_events = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        #[cfg(test)]
        let counter = raw_events.clone();
        let root = root.to_path_buf();
        let thread = std::thread::Builder::new()
            .name("tuig-watch".into())
            .spawn(move || {
                let outcome = state.run(
                    inotify,
                    &read,
                    &sink,
                    #[cfg(test)]
                    &counter,
                );
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
        })
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
}

impl State {
    /// Watches `dir`, then its subdirectories when the watch is recursive. `found` collects what the walk saw, for
    /// a directory that appeared after the watch started. A directory that vanishes during the walk is skipped.
    fn add_tree(&mut self, dir: &Path, found: &mut Vec<PathBuf>, is_root: bool) -> io::Result<()> {
        match self.watches.add(dir, watch_mask()) {
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
                for event in events {
                    #[cfg(test)]
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if event.mask.contains(EventMask::Q_OVERFLOW) {
                        overflow = true;
                        continue;
                    }
                    if event.mask.contains(EventMask::IGNORED) {
                        self.directories.remove(&event.wd);
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
                        self.add_tree(&path, &mut changed, false)?;
                    }
                    changed.push(path);
                }
                if overflow {
                    // Events were lost. An empty report counts as a change of unknown paths.
                    sink(BackendEvent::Paths(Vec::new()));
                }
                if !changed.is_empty() {
                    sink(BackendEvent::Paths(changed));
                }
            }
        }
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
        (watcher, rx)
    }

    fn next_paths(rx: &mpsc::Receiver<BackendEvent>, wanted: &Path) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(BackendEvent::Paths(paths)) if paths.iter().any(|path| path == wanted) => {
                    return true;
                }
                Ok(_) => {}
                Err(_) => return false,
            }
        }
        false
    }

    #[test]
    fn reading_files_wakes_nothing_and_writing_one_does() {
        let dir = TempDir::new("inotify-reads");
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
        assert_eq!(watcher.raw_events(), 0, "a read reached the watcher");
        assert!(rx.try_recv().is_err());

        std::fs::write(root.join("a/b/file.txt"), "two").unwrap();
        assert!(next_paths(&rx, &root.join("a/b/file.txt")));
        assert!(watcher.raw_events() > 0);
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
}
