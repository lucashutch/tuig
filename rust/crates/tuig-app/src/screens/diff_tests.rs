//! Diff pane behavior against disposable repositories in temp directories.

use super::*;
use crate::shell::Inbox;
use crate::tasks::ReqId;
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

/// A repository with `a.txt` committed as `one two three`, then edited to `ONE two THREE` in the work tree.
fn edited_repository() -> TempRepo {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("tuig-diff-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "base"]);
    std::fs::write(dir.join("a.txt"), "ONE\ntwo\nTHREE\n").unwrap();
    std::fs::write(dir.join("b.txt"), "B\n").unwrap();
    TempRepo(dir)
}

struct Harness {
    app: TestApp,
    shell: Rc<RefCell<Shell>>,
    repo: TempRepo,
}

impl Harness {
    fn new() -> Self {
        let repo = edited_repository();
        let app = TestApp::new(160, 48);
        let service = app
            .app()
            .runtime()
            .block_on(GitRepositoryService::open(&repo.0))
            .unwrap();
        let shell = Shell::start(app.app(), Arc::new(service));
        let harness = Self { app, shell, repo };
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
        let inbox: Rc<Inbox> = self.shell.borrow().inbox.clone();
        inbox.drain(self.app.app());
    }

    fn show(&self, path: &str, source: FileSource) {
        let file = SelectedFile {
            path: path.to_owned(),
            original_path: None,
            source,
        };
        self.shell
            .borrow_mut()
            .show_file_diff(self.app.app(), Some(file));
    }

    fn wait_for_document(&self, path: &str) -> Rc<DiffDocument> {
        let marker = format!("+++ b/{path}");
        self.wait("the diff", |shell| {
            shell
                .diff
                .document
                .as_ref()
                .is_some_and(|document| document.patch.contains(&marker))
        });
        self.shell.borrow().diff.document.clone().unwrap()
    }

    /// A left press on the unified row that shows `line` of the patch.
    fn press(&self, document: &DiffDocument, line: &str, alt: bool) {
        let raw = document
            .patch
            .split('\n')
            .position(|own| own == line)
            .unwrap();
        let target = document
            .unified
            .rows
            .iter()
            .filter_map(|row| row.target)
            .find(|target| target.raw_row == raw);
        self.update(Msg::DiffInput(DiffEvent::Press {
            target,
            button: MouseButton::Left,
            ctrl: false,
            alt,
            x: 0,
            y: 0,
        }));
    }

    fn index(&self) -> String {
        git(&self.repo.0, &["show", ":a.txt"])
    }
}

#[test]
fn staging_selected_lines_changes_only_those_lines_in_the_index() {
    let h = Harness::new();
    h.show("a.txt", FileSource::WorkingUnstaged);
    let document = h.wait_for_document("a.txt");

    h.press(&document, "-one", true);
    h.press(&document, "+ONE", true);
    assert_eq!(h.shell.borrow().diff.selected_rows.len(), 2);
    h.update(Msg::Key(KeyEvent::from(opentui::input::KeyCode::Enter)));
    h.wait("the mutation", |shell| shell.diff.mutation.is_none());
    assert_eq!(h.index(), "ONE\ntwo\nthree\n");

    // The reloaded unstaged diff holds only the second change. Unstage it from the staged diff instead.
    h.show("a.txt", FileSource::WorkingStaged);
    h.wait("the staged diff", |shell| {
        shell.diff.document.as_ref().is_some_and(|document| {
            document.patch.contains("+ONE") && !document.patch.contains("+THREE")
        })
    });
    let staged = h.shell.borrow().diff.document.clone().unwrap();
    h.press(&staged, "-one", false);
    h.press(&staged, "+ONE", true);
    h.shell
        .borrow_mut()
        .apply_selected_lines(h.app.app(), false);
    h.wait("the unstage", |shell| shell.diff.mutation.is_none());
    assert_eq!(h.index(), "one\ntwo\nthree\n");
    assert_eq!(
        std::fs::read_to_string(h.repo.0.join("a.txt")).unwrap(),
        "ONE\ntwo\nTHREE\n",
        "line staging leaves the work tree alone"
    );
}

#[test]
fn discarding_selected_lines_restores_them_in_the_work_tree() {
    let h = Harness::new();
    h.show("a.txt", FileSource::WorkingUnstaged);
    let document = h.wait_for_document("a.txt");
    h.press(&document, "-three", true);
    h.press(&document, "+THREE", true);
    h.shell.borrow_mut().apply_selected_lines(h.app.app(), true);
    h.wait("the discard", |shell| shell.diff.mutation.is_none());
    assert_eq!(
        std::fs::read_to_string(h.repo.0.join("a.txt")).unwrap(),
        "ONE\ntwo\nthree\n"
    );
    assert_eq!(h.index(), "one\ntwo\nthree\n");
}

#[test]
fn a_diff_result_for_a_superseded_file_is_dropped() {
    let h = Harness::new();
    h.show("a.txt", FileSource::WorkingUnstaged);
    let stale: ReqId = h.shell.borrow().tasks.diff.current();
    h.show("b.txt", FileSource::WorkingUnstaged);
    let old = DiffDocument::new(
        "diff --git a/a.txt b/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n".to_owned(),
        None,
    );
    h.update(Msg::Diff(stale, Ok(old)));
    assert!(
        h.shell.borrow().diff.document.is_none(),
        "the result for a.txt does not replace the loading b.txt"
    );
    let shown = h.wait_for_document("b.txt");
    assert!(!shown.patch.contains("a.txt"));
}

#[test]
fn a_selection_change_does_not_cancel_a_running_mutation() {
    let h = Harness::new();
    h.show("a.txt", FileSource::WorkingUnstaged);
    let document = h.wait_for_document("a.txt");
    h.press(&document, "+ONE", false);
    h.press(&document, "-one", true);
    h.shell
        .borrow_mut()
        .apply_selected_lines(h.app.app(), false);
    assert!(h.shell.borrow().tasks.mutation.busy());
    h.show("b.txt", FileSource::WorkingUnstaged);
    h.wait("the mutation", |shell| shell.diff.mutation.is_none());
    assert_eq!(h.index(), "ONE\ntwo\nthree\n");
}
