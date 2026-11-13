//! Reads history pages from one long-lived `git log` walk and tracks when it
//! goes stale. Port of `src/git/commit-walk.ts`.
//!
//! Differences from the TypeScript version:
//! - Reads are blocking. A `Mutex` serialises readers, as the promise chain did.
//! - The child's stdout is a pipe that nobody drains ahead of the reader, so
//!   Git blocks once the pipe is full. The open walk holds no unread history
//!   in memory, which makes the TypeScript chunk-size doubling unnecessary
//!   for memory. The chunk sizes stay because they decide where `--skip`
//!   restarts happen, and so how many commits Git walks.
//! - The idle timer is a short-lived thread per read. It closes the walk when
//!   no later read bumped the epoch within [`IDLE`].

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use crate::parsers::parse_log;
use crate::process::{GitError, NON_INTERACTIVE_ENV};
use crate::types::Commit;

/// Fields the history graph and commit details are built from.
pub const LOG_FORMAT: &str =
    "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%D%x1f%b%x1e";

/// Subcommands after which the open history walk can no longer be trusted.
///
/// A few of these (`reset` for unstaging, `push`) rarely move history, but an
/// unnecessary invalidation only costs one restarted walk, while a missed one
/// would page stale commits.
pub const HISTORY_MUTATING: [&str; 16] = [
    "am",
    "branch",
    "checkout",
    "cherry-pick",
    "commit",
    "fetch",
    "merge",
    "pull",
    "push",
    "rebase",
    "reset",
    "revert",
    "stash",
    "switch",
    "tag",
    "worktree",
];

/// Commits kept behind the read position so a small rewind avoids a restart.
const TAIL: usize = 8;
/// How long an unused walk is kept before it is closed.
const IDLE: Duration = Duration::from_millis(500);
/// Bounds on how many commits one spawned `git log` may emit. A walk starts
/// barely larger than the page that opened it and doubles on each continuation.
const MIN_CHUNK: usize = 512;
const MAX_CHUNK: usize = 20000;

struct Running {
    child: Child,
    out: BufReader<ChildStdout>,
}

struct Inner {
    root: PathBuf,
    running: Option<Running>,
    queue: VecDeque<Commit>,
    /// True once the walk position and tail describe a real walk.
    valid: bool,
    /// True once git stopped emitting, whether exhausted or killed.
    finished: bool,
    position: usize,
    /// Walk position at which the current `git log` stops emitting.
    chunk_end: usize,
    chunk: usize,
    tail: VecDeque<Commit>,
    /// Bumped after every read. An idle timer only fires for its own epoch.
    epoch: u64,
    /// Number of `git log` processes started. Lets tests tell a reused walk
    /// from a restarted one.
    starts: usize,
}

/// A single long-lived `git log` walk that sequential pages are read from.
///
/// `--skip=N` makes git re-walk the first N commits on every request, so paging
/// through history is quadratic. Holding the walk open and continuing to read
/// from it makes a page cost only what it emits.
pub struct CommitWalk {
    inner: Arc<Mutex<Inner>>,
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

impl CommitWalk {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                root: root.as_ref().to_path_buf(),
                running: None,
                queue: VecDeque::new(),
                valid: false,
                finished: true,
                position: 0,
                chunk_end: 0,
                chunk: MIN_CHUNK,
                tail: VecDeque::new(),
                epoch: 0,
                starts: 0,
            })),
        }
    }

    /// Reads up to `count` commits starting `offset` commits into the walk.
    pub fn read(&self, offset: usize, count: usize) -> Result<Vec<Commit>, GitError> {
        let (result, epoch) = {
            let mut inner = lock(&self.inner);
            let result = inner.read_now(offset, count);
            inner.epoch += 1;
            (result, inner.epoch)
        };
        self.close_when_idle(epoch);
        result
    }

    fn close_when_idle(&self, epoch: u64) {
        let weak: Weak<Mutex<Inner>> = Arc::downgrade(&self.inner);
        // Failing to spawn the timer only leaves the walk open until the next
        // invalidation or drop.
        let _ = std::thread::Builder::new()
            .name("tuig-walk-idle".into())
            .spawn(move || {
                std::thread::sleep(IDLE);
                if let Some(inner) = weak.upgrade() {
                    let mut inner = lock(&inner);
                    if inner.epoch == epoch {
                        inner.invalidate();
                    }
                }
            });
    }

    /// Drops the walk, so the next read starts a fresh one.
    pub fn invalidate(&self) {
        lock(&self.inner).invalidate();
    }

    #[cfg(test)]
    pub(crate) fn starts(&self) -> usize {
        lock(&self.inner).starts
    }

    #[cfg(test)]
    pub(crate) fn is_open(&self) -> bool {
        lock(&self.inner).running.is_some()
    }
}

impl Drop for CommitWalk {
    fn drop(&mut self) {
        self.invalidate();
    }
}

impl Inner {
    fn read_now(&mut self, offset: usize, count: usize) -> Result<Vec<Commit>, GitError> {
        if !self.valid || offset > self.position || offset + self.tail.len() < self.position {
            self.start(offset, false, count)?;
        }
        let reused = self.position - offset;
        let mut out: Vec<Commit> = if reused > 0 {
            let from = self.tail.len() - reused;
            self.tail.iter().skip(from).take(count).cloned().collect()
        } else {
            Vec::new()
        };
        while out.len() < count {
            match self.next()? {
                Some(commit) => out.push(commit),
                None => break,
            }
        }
        Ok(out)
    }

    fn start(&mut self, offset: usize, continuing: bool, wanted: usize) -> Result<(), GitError> {
        let tail = if continuing {
            std::mem::take(&mut self.tail)
        } else {
            VecDeque::new()
        };
        let size = if continuing {
            MAX_CHUNK.min(self.chunk * 2)
        } else {
            MIN_CHUNK.max(wanted)
        };
        self.invalidate();
        self.tail = tail;
        self.chunk = size;
        let mut args: Vec<String> = vec![
            "log".into(),
            "-z".into(),
            // Stash tips and their internal index/untracked parents live under
            // refs/stash. They have their own sidebar section via `stash list`,
            // so keep them out of the history walk where one stash reads as
            // 2-3 commit-like rows. `--exclude` must precede `--all`.
            "--exclude=refs/stash".into(),
            "--all".into(),
        ];
        if offset > 0 {
            args.push(format!("--skip={offset}"));
        }
        args.push(format!("-{size}"));
        args.push(LOG_FORMAT.into());
        let mut command = Command::new("git");
        command
            .args(&args)
            .current_dir(&self.root)
            .envs(NON_INTERACTIVE_ENV)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            // An empty repository has no commits to walk, which git reports as
            // an error rather than as empty output; an empty stream is that answer.
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|source| GitError::Spawn {
            args: args.clone(),
            source,
        })?;
        let stdout = child.stdout.take().expect("stdout is piped");
        self.running = Some(Running {
            child,
            out: BufReader::with_capacity(64 * 1024, stdout),
        });
        self.starts += 1;
        self.valid = true;
        self.finished = false;
        self.position = offset;
        self.chunk_end = offset + size;
        Ok(())
    }

    fn next(&mut self) -> Result<Option<Commit>, GitError> {
        while self.queue.is_empty() {
            if !self.finished {
                self.fill();
                continue;
            }
            // A chunk that stopped exactly on its limit is not the end of
            // history, so continue the walk where it left off. Any shorter one
            // is the end.
            if !self.valid || self.position < self.chunk_end {
                break;
            }
            self.start(self.position, true, 0)?;
        }
        let Some(commit) = self.queue.pop_front() else {
            return Ok(None);
        };
        self.position += 1;
        self.tail.push_back(commit.clone());
        if self.tail.len() > TAIL {
            self.tail.pop_front();
        }
        Ok(Some(commit))
    }

    /// Reads one record. Records end with `\x1e` and git's `-z` then separates
    /// them with NUL, which `parse_log` skips.
    fn fill(&mut self) {
        let Some(running) = self.running.as_mut() else {
            self.end();
            return;
        };
        let mut record = Vec::new();
        match running.out.read_until(0x1e, &mut record) {
            Ok(0) | Err(_) => self.end(),
            Ok(_) => {
                let text = String::from_utf8_lossy(&record);
                if record.last() != Some(&0x1e) {
                    // Truncated final record: parse what arrived, then stop.
                    self.queue.extend(parse_log(&text));
                    self.end();
                } else {
                    self.queue.extend(parse_log(&text));
                }
            }
        }
    }

    /// Releases the exhausted process, keeping the position and tail usable.
    fn end(&mut self) {
        self.finished = true;
        if let Some(mut running) = self.running.take() {
            drop(running.out);
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }

    fn invalidate(&mut self) {
        self.end();
        self.valid = false;
        self.queue.clear();
        self.tail.clear();
        self.position = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::run_git;
    use crate::test_util::{TempDir, commit, temp_repo};

    fn make_commits(dir: &TempDir, n: usize) {
        for i in 0..n {
            std::fs::write(dir.path().join(format!("f{i}.txt")), format!("{i}\n")).unwrap();
            run_git(&["add", "."], Some(dir.path())).unwrap();
            commit(dir.path(), &format!("c{i}"));
        }
    }

    fn subjects(commits: &[Commit]) -> Vec<&str> {
        commits.iter().map(|c| c.subject.as_str()).collect()
    }

    #[test]
    fn sequential_reads_continue_one_process() {
        let dir = temp_repo();
        make_commits(&dir, 8);
        let walk = CommitWalk::new(dir.path());
        assert_eq!(subjects(&walk.read(0, 2).unwrap()), ["c7", "c6"]);
        assert_eq!(subjects(&walk.read(2, 2).unwrap()), ["c5", "c4"]);
        assert_eq!(walk.starts(), 1);
        // A small rewind is served from the tail without a restart.
        assert_eq!(subjects(&walk.read(3, 2).unwrap()), ["c4", "c3"]);
        assert_eq!(walk.starts(), 1);
        // A jump past the position restarts with --skip.
        assert_eq!(subjects(&walk.read(7, 3).unwrap()), ["c0"]);
        assert_eq!(walk.starts(), 2);
    }

    #[test]
    fn rewinding_past_the_tail_restarts() {
        let dir = temp_repo();
        make_commits(&dir, 14);
        let walk = CommitWalk::new(dir.path());
        assert_eq!(walk.read(0, 12).unwrap().len(), 12);
        let page = walk.read(1, 2).unwrap();
        assert_eq!(subjects(&page), ["c12", "c11"]);
        assert_eq!(walk.starts(), 2);
    }

    #[test]
    fn exhausted_walk_reports_short_pages() {
        let dir = temp_repo();
        make_commits(&dir, 3);
        let walk = CommitWalk::new(dir.path());
        assert_eq!(walk.read(0, 10).unwrap().len(), 3);
        assert!(walk.read(3, 10).unwrap().is_empty());
        assert!(walk.read(50, 10).unwrap().is_empty());
    }

    #[test]
    fn empty_repository_reads_nothing() {
        let dir = temp_repo();
        let walk = CommitWalk::new(dir.path());
        assert!(walk.read(0, 10).unwrap().is_empty());
        assert!(walk.read(5, 10).unwrap().is_empty());
    }

    #[test]
    fn invalidate_makes_the_next_read_see_new_commits() {
        let dir = temp_repo();
        make_commits(&dir, 2);
        let walk = CommitWalk::new(dir.path());
        assert_eq!(walk.read(0, 1).unwrap()[0].subject, "c1");
        std::fs::write(dir.path().join("extra"), "x").unwrap();
        run_git(&["add", "."], Some(dir.path())).unwrap();
        commit(dir.path(), "extra");
        walk.invalidate();
        assert!(!walk.is_open());
        assert_eq!(walk.read(0, 1).unwrap()[0].subject, "extra");
    }

    #[test]
    fn idle_walk_closes_its_process() {
        let dir = temp_repo();
        make_commits(&dir, 2);
        let walk = CommitWalk::new(dir.path());
        walk.read(0, 1).unwrap();
        // The first record leaves the second unread, so the process stays open.
        assert!(walk.is_open());
        std::thread::sleep(IDLE + Duration::from_millis(400));
        assert!(!walk.is_open());
        // The walk still works after the idle close.
        assert_eq!(walk.read(0, 1).unwrap()[0].subject, "c1");
    }
}
