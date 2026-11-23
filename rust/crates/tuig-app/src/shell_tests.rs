//! Shell behavior against real repositories in temp directories, driven through `TestApp`.

use super::*;
use crate::refresh::WatchSignal;
use crate::screens::history::{SCROLL_BATCH, SCROLL_SETTLE};
use opentui::testing::TestApp;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};
use std::time::{Duration, Instant};
use tuig_git::repository::GitRepositoryService;
use tuig_ui_model::history_viewport::HistorySelection;

const WAIT: Duration = Duration::from_secs(20);

struct TempRepo(PathBuf);

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) {
    let status = Process::new("git")
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// A repository with `count` linear commits on `main` and a clean work tree. Built with `git fast-import`, so a
/// few hundred commits take one process.
fn repository(count: usize) -> TempRepo {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("tuig-app-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    let mut stream = String::new();
    for i in 0..count {
        let content = format!("{i}\n");
        stream.push_str(&format!(
            "commit refs/heads/main\ncommitter T <t@example.com> {} +0000\ndata {}\ncommit {i}\n",
            1_700_000_000 + i,
            format!("commit {i}\n").len() - 1,
        ));
        stream.push_str(&format!(
            "M 100644 inline file.txt\ndata {}\n{content}\n",
            content.len()
        ));
    }
    let mut import = Process::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    import
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    assert!(import.wait().unwrap().success());
    git(&dir, &["reset", "-q", "--hard", "main"]);
    TempRepo(dir)
}

struct Harness {
    app: TestApp,
    shell: Rc<RefCell<Shell>>,
    _repo: TempRepo,
}

impl Harness {
    fn new(commits: usize) -> Self {
        Self::open(repository(commits))
    }

    /// Like `new`, with HEAD detached `back` commits behind `main`.
    fn detached(commits: usize, back: usize) -> Self {
        let repo = repository(commits);
        git(
            &repo.0,
            &["checkout", "-q", "--detach", &format!("main~{back}")],
        );
        Self::open(repo)
    }

    fn open(repo: TempRepo) -> Self {
        let app = TestApp::new(160, 48);
        let service = app
            .app()
            .runtime()
            .block_on(GitRepositoryService::open(&repo.0))
            .unwrap();
        let shell = Shell::start(app.app(), Arc::new(service));
        let harness = Self {
            app,
            shell,
            _repo: repo,
        };
        harness.wait("the first snapshot", |shell| shell.snapshot.is_some());
        harness
    }

    fn wait(&self, what: &str, mut condition: impl FnMut(&Shell) -> bool) {
        let shell = &self.shell;
        assert!(
            self.app.wait_until(WAIT, || condition(&shell.borrow())),
            "timed out waiting for {what}"
        );
    }

    fn update(&self, msg: Msg) {
        self.shell.borrow_mut().update(self.app.app(), msg);
    }

    fn read<R>(&self, read: impl FnOnce(&Shell) -> R) -> R {
        read(&self.shell.borrow())
    }
}

#[test]
fn a_result_for_a_superseded_request_is_dropped() {
    let h = Harness::new(10);
    let first = h.read(|shell| shell.tasks.snapshot.current());
    let stale = h.read(|shell| {
        let mut snapshot = shell.snapshot.clone().unwrap();
        snapshot.commits = shell.history.commits[..1].to_vec();
        snapshot
    });
    // A refresh supersedes the first request.
    h.shell.borrow_mut().request_refresh(h.app.app(), false);
    assert_ne!(h.read(|shell| shell.tasks.snapshot.current()), first);
    h.update(Msg::Snapshot(first, Ok(stale)));
    assert_eq!(h.read(|shell| shell.history.commits.len()), 10);
    h.wait("the refresh", |shell| !shell.tasks.snapshot.busy());
    assert_eq!(h.read(|shell| shell.history.commits.len()), 10);
}

#[test]
fn wheel_notches_within_one_batch_scroll_once() {
    let h = Harness::new(100);
    h.update(Msg::HistoryWheel(1));
    h.app.advance(Duration::from_millis(10));
    h.update(Msg::HistoryWheel(1));
    assert_eq!(
        h.read(|shell| shell.history.viewport.start),
        0,
        "nothing moves before the batch ends"
    );
    // The batch timer started with the first notch and does not restart.
    h.app.advance(SCROLL_BATCH - Duration::from_millis(10));
    assert_eq!(h.read(|shell| shell.history.viewport.start), 2);
    assert!(h.read(|shell| shell.history.scrolling));
    h.app.advance(SCROLL_SETTLE);
    assert!(!h.read(|shell| shell.history.scrolling));
    assert_eq!(
        h.read(|shell| shell.history.selection),
        HistorySelection::Commit(0),
        "the wheel does not move the selection"
    );
    assert_eq!(
        h.read(|shell| shell.history.window.as_ref().map(|window| window.start)),
        Some(2),
        "the widget got the new window"
    );
}

#[test]
fn a_burst_of_wheel_notches_moves_the_viewport_once_and_settles_once() {
    let h = Harness::new(100);
    // Ten notches 1 ms apart, the last at t=9 ms.
    for _ in 0..10 {
        h.update(Msg::HistoryWheel(1));
        h.app.advance(Duration::from_millis(1));
    }
    assert_eq!(h.read(|shell| shell.history.viewport.start), 0);
    h.app.advance(SCROLL_BATCH - Duration::from_millis(10));
    assert_eq!(
        h.read(|shell| shell.history.viewport.start),
        10,
        "all notches landed in one move"
    );
    // The settle delay restarted on every notch, so it runs from the last one at t=9 ms.
    h.app.advance(SCROLL_SETTLE - Duration::from_millis(8));
    assert!(h.read(|shell| shell.history.scrolling));
    h.app.advance(Duration::from_millis(1));
    assert!(!h.read(|shell| shell.history.scrolling));
    h.read(|shell| {
        assert!(shell.history.scroll_timer.is_none() && shell.history.settle_timer.is_none());
    });
}

#[test]
fn the_settle_delay_waits_for_the_scrollbar_to_be_released() {
    let h = Harness::new(100);
    h.update(Msg::HistoryWheel(1));
    h.shell
        .borrow_mut()
        .history
        .pointer
        .hold_scrollbar(tuig_ui_model::scrollbar::scrollbar_grab(100, 0, 10, 1));
    h.app.advance(SCROLL_BATCH + SCROLL_SETTLE);
    assert!(h.read(|shell| shell.history.scrolling));
    h.shell.borrow_mut().release_history_scrollbar(h.app.app());
    h.app.advance(SCROLL_SETTLE);
    assert!(!h.read(|shell| shell.history.scrolling));
}

#[test]
fn the_selected_commit_stays_selected_when_a_watched_commit_lands() {
    let h = Harness::new(10);
    h.wait("the watcher", |shell| shell.refresh.watcher.is_some());
    h.shell.borrow_mut().move_commit(2);
    let selected = h.read(|shell| shell.history.selected_sha().unwrap().to_owned());

    git(&h._repo.0, &["commit", "-q", "--allow-empty", "-m", "new"]);

    h.wait("the refresh after the commit", |shell| {
        shell.history.commits.len() == 11
    });
    assert_eq!(
        h.read(|shell| shell.history.selection),
        HistorySelection::Commit(3)
    );
    assert_eq!(
        h.read(|shell| shell.history.selected_sha().map(str::to_owned)),
        Some(selected)
    );
}

#[test]
fn scrolling_near_the_end_loads_the_next_page() {
    let h = Harness::new(300);
    assert_eq!(h.read(|shell| shell.history.commits.len()), 250);
    h.update(Msg::HistoryWheel(300));
    h.app.advance(SCROLL_BATCH);
    h.wait("the second page", |shell| shell.history.complete);
    h.read(|shell| {
        assert_eq!(shell.history.commits.len(), 300);
        assert_eq!(shell.history.index.length, 300, "the graph covers the page");
        let subjects: Vec<&str> = shell.history.commits[248..252]
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect();
        assert_eq!(
            subjects,
            ["commit 51", "commit 50", "commit 49", "commit 48"],
            "the overlap commit is not repeated"
        );
    });
}

#[test]
fn a_change_seen_during_a_refresh_refreshes_again_afterwards() {
    let h = Harness::new(10);
    h.wait("the watcher", |shell| shell.refresh.watcher.is_some());
    let generation = h.read(|shell| shell.refresh.generation);

    h.update(Msg::Watch {
        generation: generation + 1,
        event: WatchSignal::Changed { at: Instant::now() },
    });
    assert!(
        !h.read(|shell| shell.tasks.snapshot.busy()),
        "an event from another watcher is dropped"
    );

    h.shell.borrow_mut().request_refresh(h.app.app(), false);
    let at = Instant::now();
    h.update(Msg::Watch {
        generation,
        event: WatchSignal::Changed { at },
    });
    h.wait("a refresh that starts after the change", |shell| {
        shell
            .tasks
            .snapshot
            .started_at()
            .is_some_and(|started| started > at)
    });
}

fn head_sha(dir: &Path) -> String {
    let out = Process::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

#[test]
fn a_detached_head_behind_the_tip_is_selected_and_centered() {
    let h = Harness::detached(100, 60);
    h.wait("the head to be focused", |shell| {
        shell.history.focus_sha.is_none()
    });
    h.read(|shell| {
        assert_eq!(shell.history.selection, HistorySelection::Commit(60));
        assert_eq!(
            shell.history.selected_sha(),
            Some(head_sha(&h._repo.0).as_str())
        );
        // 43 body lines: the start puts row 60 at line 21.
        assert_eq!(shell.history.viewport.start, 39);
        assert!(!shell.history.viewport.detached);
    });
}

#[test]
fn a_head_beyond_the_first_page_is_paged_in_before_it_is_selected() {
    let h = Harness::detached(300, 270);
    h.wait("the head to be focused", |shell| {
        shell.history.focus_sha.is_none()
    });
    h.read(|shell| {
        assert_eq!(shell.history.commits.len(), 300);
        assert_eq!(shell.history.selection, HistorySelection::Commit(270));
        assert_eq!(
            shell.history.selected_sha(),
            Some(head_sha(&h._repo.0).as_str())
        );
        assert_eq!(shell.history.viewport.start, 249);
    });
}
