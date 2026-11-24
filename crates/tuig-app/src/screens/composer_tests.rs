//! Composer behavior against disposable repositories: commits, amends, message edits and the keyboard hand-over.

use super::*;
use opentui::testing::TestApp;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tuig_git::repository::GitRepositoryService;

const WAIT: Duration = Duration::from_secs(20);

struct TempRepo(PathBuf);

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Process::new("git")
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap()
}

/// A repository with one commit "first" per name in `subjects`, oldest first. `stage` adds a staged file.
fn repository(subjects: &[&str], stage: bool) -> TempRepo {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("tuig-composer-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    // The app commits through plain `git`, so the identity must be in the repository config, not only in `-c`.
    git(&dir, &["config", "user.name", "T"]);
    git(&dir, &["config", "user.email", "t@example.com"]);
    for (index, subject) in subjects.iter().enumerate() {
        std::fs::write(dir.join("a.txt"), format!("{index}\n")).unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", subject]);
    }
    if stage {
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        git(&dir, &["add", "b.txt"]);
    }
    TempRepo(dir)
}

struct Harness {
    app: TestApp,
    shell: Rc<RefCell<Shell>>,
    repo: TempRepo,
}

impl Harness {
    fn new(subjects: &[&str], stage: bool) -> Self {
        let repo = repository(subjects, stage);
        let app = TestApp::new(160, 48);
        let service = app
            .app()
            .runtime()
            .block_on(GitRepositoryService::open(&repo.0))
            .unwrap();
        let shell = Shell::start(app.app(), Arc::new(service));
        let harness = Self { app, shell, repo };
        harness.wait("the first snapshot", |shell| shell.snapshot_complete());
        harness.wait("the history", |shell| {
            shell.history.commits.len() == subjects.len()
        });
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

    fn act(&self, action: ComposerAction) {
        self.act_msg(Msg::Composer(action));
    }

    fn act_msg(&self, msg: Msg) {
        let inbox = self.read(|shell| shell.inbox.clone());
        inbox.post(self.app.app(), msg);
        self.app.advance(Duration::ZERO);
    }

    fn act_overlay(&self, msg: crate::screens::popup::OverlayMsg) {
        self.act_msg(Msg::Overlay(msg));
    }

    /// Opens the history's selected commit and draws it.
    fn open_selected_commit(&self) {
        self.shell.borrow_mut().open_commit();
        let inbox = self.read(|shell| shell.inbox.clone());
        inbox.drain(self.app.app());
        self.app.advance(Duration::ZERO);
    }

    fn summary(&self) -> String {
        self.read(|shell| shell.widgets.composer.summary.value())
    }

    fn body(&self) -> String {
        self.read(|shell| shell.widgets.composer.body.text())
    }

    fn last_message(&self) -> String {
        git(&self.repo.0, &["log", "-1", "--format=%B"])
            .trim_end()
            .to_owned()
    }

    fn commit_count(&self) -> usize {
        git(&self.repo.0, &["rev-list", "--count", "HEAD"])
            .trim()
            .parse()
            .unwrap()
    }

    /// Waits until the commit, amend or message save has finished and the shell reads the new snapshot.
    fn wait_for_mutation(&self) {
        self.wait("the mutation", |shell| shell.diff.mutation.is_none());
        self.wait("the refresh", |shell| !shell.tasks.snapshot.busy());
    }
}

#[test]
fn enter_in_the_summary_commits_the_staged_files_with_the_description() {
    let h = Harness::new(&["base"], true);
    h.app.press("c");
    assert!(h.read(|shell| shell.composing()));
    h.app.type_text("Add b");
    h.app.press("tab");
    h.app.type_text("Because b matters.");
    h.app.press("shift+tab");
    h.app.press("enter");
    h.wait_for_mutation();

    assert_eq!(h.last_message(), "Add b\n\nBecause b matters.");
    assert_eq!(h.commit_count(), 2);
    assert_eq!((h.summary(), h.body()), (String::new(), String::new()));
    assert!(!h.read(|shell| shell.composing()), "the keyboard is free");
    h.wait("the staged list to empty", |shell| {
        shell.files.staged_count() == 0
    });
    assert!(h.app.text().contains("Stage files to commit"));
}

#[test]
fn a_commit_without_a_summary_or_staged_files_changes_nothing() {
    let h = Harness::new(&["base"], false);
    h.app.press("c");
    h.app.press("enter");
    assert_eq!(
        h.read(|shell| shell.notice.clone()).as_deref(),
        Some("Commit summary cannot be empty")
    );
    h.app.type_text("Nothing to commit");
    h.app.press("enter");
    assert_eq!(
        h.read(|shell| shell.notice.clone()).as_deref(),
        Some("Nothing staged to commit")
    );
    assert_eq!(h.commit_count(), 1);
    assert_eq!(h.summary(), "Nothing to commit", "the text stays");
}

#[test]
fn the_fields_keep_every_key_until_escape_gives_the_keyboard_back() {
    let h = Harness::new(&["one", "two", "three"], false);
    let selected = h.read(|shell| shell.history.selection);
    h.app.press("c");
    // `j` moves the history and `q` quits, outside the composer.
    h.app.type_text("jq r");
    h.app.press("tab");
    h.app.type_text("jk");
    assert_eq!((h.summary().as_str(), h.body().as_str()), ("jq r", "jk"));
    assert_eq!(h.read(|shell| shell.history.selection), selected);

    h.app.press("esc");
    assert!(!h.read(|shell| shell.composing()));
    assert_eq!(h.summary(), "jq r", "leaving keeps the draft");
    h.app.press("j");
    assert_ne!(h.read(|shell| shell.history.selection), selected);
}

#[test]
fn amend_shows_the_last_message_and_gives_the_draft_back() {
    let h = Harness::new(&["old subject"], true);
    h.app.press("c");
    h.app.type_text("my draft");
    h.act(ComposerAction::ToggleAmend);
    assert_eq!(h.summary(), "old subject");
    assert!(h.app.text().contains("[x] Amend previous commit"));
    h.act(ComposerAction::ToggleAmend);
    assert_eq!(h.summary(), "my draft");
    assert!(h.app.text().contains("[ ] Amend previous commit"));
}

#[test]
fn an_amend_replaces_the_last_commit() {
    let h = Harness::new(&["old subject"], true);
    h.act(ComposerAction::ToggleAmend);
    h.read(|shell| shell.widgets.composer.summary.set_value("new subject"));
    h.act(ComposerAction::Commit);
    h.wait_for_mutation();

    assert_eq!(h.commit_count(), 1);
    assert_eq!(h.last_message(), "new subject");
    assert_eq!(
        git(&h.repo.0, &["show", "--name-only", "--format=", "HEAD"])
            .trim()
            .lines()
            .count(),
        2,
        "the staged file joined the commit"
    );
    assert_eq!(h.summary(), "");
    assert!(!h.read(|shell| shell.composer.model.amend));
}

#[test]
fn editing_a_message_rewords_an_older_commit_and_restores_the_draft() {
    let h = Harness::new(&["first", "second"], false);
    h.read(|shell| shell.widgets.composer.summary.set_value("work in progress"));
    // Open the older commit.
    h.shell.borrow_mut().move_commit(1);
    h.open_selected_commit();
    assert!(h.app.text().contains("Edit Message"));

    h.act(ComposerAction::EditMessage);
    assert_eq!(h.summary(), "first");
    let screen = h.app.text();
    assert!(
        screen.contains("Save message"),
        "the button saves the message"
    );
    assert!(
        !screen.contains("Edit Message"),
        "the composer replaces the commit card"
    );
    assert!(h.read(|shell| shell.composing()), "the summary has focus");

    h.read(|shell| shell.widgets.composer.summary.set_value("first, reworded"));
    h.app.press("enter");
    h.wait_for_mutation();

    assert_eq!(
        git(&h.repo.0, &["log", "--format=%s"])
            .lines()
            .collect::<Vec<_>>(),
        ["second", "first, reworded"]
    );
    assert_eq!(h.summary(), "work in progress", "the draft is back");
    assert!(h.read(|shell| !shell.composer.editing()));
    assert!(
        h.app.text().contains("Edit Message"),
        "the commit card is back"
    );
}

#[test]
fn escape_leaves_a_message_edit_without_saving() {
    let h = Harness::new(&["first", "second"], false);
    h.shell.borrow_mut().move_commit(1);
    h.open_selected_commit();
    h.act(ComposerAction::EditMessage);
    h.app.type_text("!");
    h.app.press("esc");

    assert!(h.read(|shell| !shell.composer.editing()));
    assert_eq!(h.summary(), "", "the draft from before the edit is back");
    assert!(h.read(|shell| shell.commit_open()), "the commit stays open");
    assert_eq!(
        git(&h.repo.0, &["log", "-1", "--format=%s", "HEAD~1"]).trim(),
        "first"
    );
}

#[test]
fn a_watched_change_waits_until_the_user_leaves_the_composer() {
    let h = Harness::new(&["base"], false);
    h.wait("the watcher", |shell| shell.refresh.watcher.is_some());
    h.wait("the first read", |shell| !shell.tasks.snapshot.busy());
    let generation = h.read(|shell| shell.refresh.generation);
    h.app.press("c");
    h.app.type_text("half a mes");

    let inbox = h.read(|shell| shell.inbox.clone());
    inbox.post(
        h.app.app(),
        Msg::Watch {
            generation,
            event: crate::refresh::WatchSignal::Changed {
                at: std::time::Instant::now(),
            },
        },
    );
    h.app.advance(Duration::ZERO);
    assert!(
        !h.read(|shell| shell.tasks.snapshot.busy()),
        "typing is not interrupted by a refresh"
    );

    let before = h.read(|shell| shell.tasks.snapshot.started_at());
    h.app.press("esc");
    h.wait("the held refresh", |shell| {
        shell.tasks.snapshot.started_at() != before
    });
    assert_eq!(h.summary(), "half a mes");
}

#[test]
fn the_palette_compose_command_focuses_the_summary() {
    use crate::screens::popup::OverlayMsg;
    let h = Harness::new(&["base"], true);
    h.shell.borrow_mut().toggle_palette(h.app.app());
    h.read(|shell| {
        shell
            .widgets
            .overlay
            .palette_input
            .set_value("compose commit")
    });
    h.act_overlay(OverlayMsg::PaletteQuery);
    h.act_overlay(OverlayMsg::PaletteSubmit);
    assert!(h.read(|shell| shell.composing()));
}

#[test]
fn the_background_fetch_waits_while_a_message_field_has_focus() {
    let h = Harness::new(&["base"], false);
    h.wait("the first read", |shell| !shell.tasks.snapshot.busy());
    h.app.press("c");
    h.act_msg(Msg::BackgroundFetch);
    assert!(h.read(|shell| shell.diff.mutation.is_none()));
}
