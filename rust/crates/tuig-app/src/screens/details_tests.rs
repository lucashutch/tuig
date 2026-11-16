//! Details pane, file history and blame against a real repository, driven through `TestApp`.

use super::*;
use crate::shell::Shell;
use opentui::testing::TestApp;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tuig_git::repository::GitRepositoryService;
use tuig_git::types::FileState;

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

/// Three commits on `main`. `notes.txt` has three lines. The second commit changes line 2 and the third adds an
/// unrelated file, so line 1 blames to the first commit and line 2 to the second.
fn repository() -> TempRepo {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("tuig-details-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("notes.txt"), "one\ntwo\nthree\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "add notes"]);
    std::fs::write(dir.join("notes.txt"), "one\nTWO\nthree\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "shout line two"]);
    std::fs::write(dir.join("other.txt"), "x\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "add other"]);
    TempRepo(dir)
}

struct Harness {
    app: TestApp,
    shell: Rc<RefCell<Shell>>,
    _repo: TempRepo,
}

impl Harness {
    fn new() -> Self {
        let repo = repository();
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

    fn read<R>(&self, read: impl FnOnce(&Shell) -> R) -> R {
        read(&self.shell.borrow())
    }

    fn notes() -> ChangedFile {
        ChangedFile {
            path: "notes.txt".into(),
            original_path: None,
            state: FileState::Modified,
            staged: false,
            unstaged: false,
            submodule: None,
        }
    }

    fn subject_at(&self, index: usize) -> String {
        self.read(|shell| shell.history.commits[index].subject.clone())
    }
}

#[test]
fn clicking_a_commit_opens_its_details_and_the_selection_keeps_them_current() {
    let h = Harness::new();
    // The history starts at row 3 with a header line, then one row per commit, newest first. A click needs a
    // painted frame for its hit grid.
    h.app.render();
    h.app.click(60, 3 + 2);
    h.wait("the details pane", |shell| shell.commit_open());
    let screen = h.app.text();
    assert!(screen.contains("COMMIT MESSAGE"), "{screen}");
    assert!(screen.contains("shout line two"), "{screen}");

    h.app.press("down");
    h.wait("the next commit", |shell| {
        shell
            .details_commit()
            .is_some_and(|c| c.subject == "add notes")
    });
    assert!(h.app.text().contains("add notes"));
    assert_eq!(
        h.read(|shell| shell.details_commit().map(|c| c.sha.clone())),
        h.read(|shell| shell.selected_commit().map(|c| c.sha.clone())),
    );

    // Escape leaves the commit view and goes back to the working row.
    h.app.press("escape");
    h.wait("the pane to close", |shell| !shell.commit_open());
    // The composer's own label reads COMMIT MESSAGE too, so look for the card's button.
    assert!(!h.app.text().contains("Edit Message"));
}

#[test]
fn a_stale_file_history_result_is_dropped() {
    let h = Harness::new();
    let app = h.app.app();
    h.shell
        .borrow_mut()
        .show_file_history(app, Harness::notes(), None);
    let first = h.read(|shell| shell.tasks.file_history.current());
    // A second request supersedes the first. Its result must not install, even when the first arrives late.
    h.shell
        .borrow_mut()
        .show_file_history(app, Harness::notes(), Some("HEAD~1".into()));
    assert_ne!(h.read(|shell| shell.tasks.file_history.current()), first);
    let stale = HistoryLoaded {
        file: Harness::notes(),
        line: None,
        result: Ok(vec![h.read(|shell| shell.history.commits[2].clone())]),
    };
    h.shell
        .borrow_mut()
        .update(app, Msg::FileHistory(first, stale));
    assert!(h.read(|shell| shell.details.file_history.is_none()));

    h.wait("the second request", |shell| {
        shell.details.file_history.is_some()
    });
    // Started at HEAD~1, so it holds the two commits that touch notes.txt, newest first.
    let subjects: Vec<String> = h.read(|shell| {
        shell
            .details
            .file_history
            .as_ref()
            .unwrap()
            .commits
            .iter()
            .map(|c| c.subject.clone())
            .collect()
    });
    assert_eq!(subjects, ["shout line two", "add notes"]);
}

#[test]
fn file_history_drives_the_details_and_escape_closes_it_before_the_pane() {
    let h = Harness::new();
    let app = h.app.app();
    h.shell
        .borrow_mut()
        .show_file_history(app, Harness::notes(), None);
    h.wait("the history", |shell| shell.details.file_history.is_some());
    assert_eq!(
        h.read(|shell| shell.details_commit().map(|c| c.subject.clone())),
        Some("shout line two".into()),
        "the newest commit that touches the file is selected"
    );
    h.app.press("down");
    h.wait("the older commit", |shell| {
        shell
            .details_commit()
            .is_some_and(|c| c.subject == "add notes")
    });
    let screen = h.app.text();
    assert!(screen.contains("File history"), "{screen}");

    h.app.press("escape");
    h.wait("the history to close", |shell| {
        shell.details.file_history.is_none()
    });
    assert!(h.read(|shell| shell.commit_open()), "the commit pane stays");
    h.app.press("escape");
    h.wait("the pane to close", |shell| !shell.commit_open());
}

#[test]
fn blame_maps_each_line_to_the_commit_that_last_changed_it() {
    let h = Harness::new();
    let app = h.app.app();
    for (line, subject) in [(1, "add notes"), (2, "shout line two"), (3, "add notes")] {
        h.shell
            .borrow_mut()
            .blame_line(app, "notes.txt".into(), line, None);
        h.wait("the blame", |shell| {
            shell.notice.as_ref().is_some_and(|n| n.ends_with(subject))
        });
        let sha = h.read(|shell| {
            let commit = shell
                .history
                .commits
                .iter()
                .find(|c| c.subject == subject)
                .unwrap();
            short_sha(&commit.sha).to_string()
        });
        h.read(|shell| assert!(shell.notice.as_ref().unwrap().starts_with(&sha)));
        h.shell.borrow_mut().notice = None;
    }
    // Blame at an older commit ignores later edits.
    let first = h.read(|shell| shell.history.commits[2].sha.clone());
    h.shell
        .borrow_mut()
        .blame_line(app, "notes.txt".into(), 2, Some(first));
    h.wait("the old blame", |shell| shell.notice.is_some());
    assert!(
        h.read(|shell| shell.notice.clone().unwrap())
            .ends_with("add notes")
    );
    assert_eq!(h.subject_at(2), "add notes");
}
