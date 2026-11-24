//! Details pane, file history and blame against a real repository, driven through `TestApp`.

use super::*;
use crate::selected_file::FileSource;
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

    /// Runs `open_comparison` the way the graph menu does, inside a message, so the files pane settles after it.
    fn compare(&self, base: &str, target: &str) {
        let app = self.app.app();
        let mut shell = self.shell.borrow_mut();
        shell.open_comparison(base.to_owned(), target);
        shell.update(app, Msg::CommitFilesDue);
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
    // The history opens the diff of the selected commit, and the changes pane has focus.
    h.wait("the diff of the newest commit", |shell| {
        shell.diff.file.as_ref().is_some_and(|file| {
            file.path == "notes.txt" && file.source == FileSource::Commit(newest_sha(shell))
        })
    });
    // The wheel over the list and a click on a card move the selection, and the diff follows.
    h.shell
        .borrow_mut()
        .update(h.app.app(), Msg::FileHistoryWheel(1));
    h.wait("the older commit", |shell| {
        shell
            .details_commit()
            .is_some_and(|c| c.subject == "add notes")
    });
    h.wait("the diff of the older commit", |shell| {
        shell.diff.file.as_ref().is_some_and(|file| {
            file.source == FileSource::Commit(shell.details_commit().unwrap().sha.clone())
        })
    });
    h.shell
        .borrow_mut()
        .update(h.app.app(), Msg::FileHistoryClick(0));
    h.wait("the newest commit again", |shell| {
        shell
            .details_commit()
            .is_some_and(|c| c.subject == "shout line two")
    });
    let screen = h.app.text();
    assert!(screen.contains("File history"), "{screen}");

    // One Escape closes the history and its diff together.
    h.app.press("escape");
    h.wait("the history to close", |shell| {
        shell.details.file_history.is_none()
    });
    assert!(h.read(|shell| !shell.diff.is_open()), "the diff closes too");
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

#[test]
fn the_arrow_and_vim_keys_step_through_the_file_history() {
    let h = Harness::new();
    let app = h.app.app();
    // A third commit on the file, so that two steps both move.
    std::fs::write(h._repo.0.join("notes.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    git(&h._repo.0, &["commit", "-q", "-am", "add four"]);
    h.shell
        .borrow_mut()
        .show_file_history(app, Harness::notes(), None);
    h.wait("the history", |shell| {
        shell
            .details
            .file_history
            .as_ref()
            .is_some_and(|history| history.commits.len() == 3)
    });
    h.wait("the diff of the newest commit", |shell| {
        shell.diff.file.as_ref().is_some_and(|file| {
            file.source == FileSource::Commit(shell.details_commit().unwrap().sha.clone())
        })
    });
    assert_eq!(
        h.read(|shell| shell.details_commit().map(|c| c.subject.clone())),
        Some("add four".into())
    );

    for (key, subject) in [("down", "shout line two"), ("j", "add notes")] {
        h.app.press(key);
        h.wait(subject, |shell| {
            shell
                .details_commit()
                .is_some_and(|commit| commit.subject == subject)
        });
        h.wait("the diff to follow", |shell| {
            shell.diff.file.as_ref().is_some_and(|file| {
                file.source == FileSource::Commit(shell.details_commit().unwrap().sha.clone())
            })
        });
    }
}

fn newest_sha(shell: &Shell) -> String {
    shell
        .details
        .file_history
        .as_ref()
        .and_then(|history| history.selected_commit())
        .map(|commit| commit.sha.clone())
        .unwrap_or_default()
}

#[test]
fn comparing_two_commits_lists_the_changes_between_them_and_ends_with_the_next_selection() {
    let h = Harness::new();
    let (newest, oldest) = h.read(|shell| {
        (
            shell.history.commits[0].sha.clone(),
            shell.history.commits[2].sha.clone(),
        )
    });

    // The same commit on both ends compares nothing.
    h.compare(&newest, &newest);
    assert!(h.read(|shell| shell.files.comparison.is_none() && !shell.commit_open()));

    h.compare(&oldest, &newest);
    h.wait("the files between the commits", |shell| {
        shell.files.commit.files.is_some()
    });
    let (paths, selected) = h.read(|shell| {
        let mut paths: Vec<String> = shell
            .files
            .commit
            .files
            .iter()
            .flat_map(|files| files.iter().map(|file| file.path.clone()))
            .collect();
        paths.sort();
        (paths, shell.files.selected.clone())
    });
    // `notes.txt` changed in the second commit and `other.txt` in the third. The first commit is the base, so
    // both count.
    assert_eq!(paths, ["notes.txt", "other.txt"]);
    assert_eq!(
        selected.map(|file| file.source),
        Some(FileSource::Comparison {
            base: oldest.clone(),
            target: newest.clone()
        })
    );
    h.app.render();
    let screen = h.app.text();
    let short = |sha: &str| sha[..8].to_owned();
    assert!(
        screen.contains(&format!("Compare {} → {}", short(&oldest), short(&newest))),
        "{screen}"
    );
    assert!(screen.contains("add notes"), "{screen}");
    assert!(screen.contains("→ add other"), "{screen}");

    // Another commit ends the comparison and shows its own files.
    h.app.press("down");
    h.wait("the comparison to end", |shell| {
        shell.files.comparison.is_none()
    });
    h.wait("the files of the commit", |shell| {
        shell.files.commit.files.is_some() && shell.files.commit.base.is_none()
    });
    assert!(!h.app.text().contains("Compare "), "{}", h.app.text());
}

#[test]
fn escape_leaves_a_comparison() {
    let h = Harness::new();
    let (newest, oldest) = h.read(|shell| {
        (
            shell.history.commits[0].sha.clone(),
            shell.history.commits[2].sha.clone(),
        )
    });
    h.compare(&oldest, &newest);
    h.wait("the comparison", |shell| shell.files.commit.files.is_some());
    h.app.press("escape");
    h.wait("the view to close", |shell| !shell.commit_open());
    assert!(h.read(|shell| shell.files.comparison.is_none()));
}

#[test]
fn a_refresh_keeps_the_comparison_open() {
    let h = Harness::new();
    let (newest, oldest) = h.read(|shell| {
        (
            shell.history.commits[0].sha.clone(),
            shell.history.commits[2].sha.clone(),
        )
    });
    h.compare(&oldest, &newest);
    h.wait("the comparison", |shell| shell.files.commit.files.is_some());
    {
        let app = h.app.app();
        let mut shell = h.shell.borrow_mut();
        shell.request_refresh(app, false);
        assert!(shell.tasks.snapshot.busy(), "the refresh must start");
    }
    h.wait("the refresh to finish", |shell| {
        !shell.tasks.snapshot.busy()
    });
    h.wait("the files", |shell| shell.files.commit.files.is_some());
    assert!(h.read(|shell| shell.commit_open()));
    assert_eq!(
        h.read(|shell| shell
            .files
            .comparison
            .as_ref()
            .map(|c| (c.base.clone(), c.target.clone()))),
        Some((oldest.clone(), newest.clone()))
    );
    h.app.render();
    let screen = h.app.text();
    assert!(
        screen.contains(&format!("Compare {} → {}", &oldest[..8], &newest[..8])),
        "{screen}"
    );
}

#[test]
fn the_co_author_line_drops_initials_for_provider_names_only_with_graphics() {
    let authors = vec![
        CoAuthor {
            name: "Claude".into(),
            email: "noreply@anthropic.com".into(),
        },
        CoAuthor {
            name: "Grace Hopper".into(),
            email: "grace@example.com".into(),
        },
    ];
    assert_eq!(
        co_authors_plain(&authors, true),
        "Co-authors: Claude  [GH] Grace Hopper"
    );
    assert_eq!(
        co_authors_plain(&authors, false),
        "Co-authors: [CL] Claude  [GH] Grace Hopper"
    );
}
