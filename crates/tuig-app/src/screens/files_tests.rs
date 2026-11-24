//! The changed-files pane against a real repository, driven through `TestApp` and messages.

use super::*;
use crate::selected_file::FileSource;
use crate::shell::Msg;
use opentui::testing::TestApp;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};
use std::sync::Arc;
use tuig_git::repository::GitRepositoryService;
use tuig_widgets::history::ClickPart;

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

fn write(dir: &Path, path: &str, content: &str) {
    let path = dir.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

/// Three commits, then working changes: `src/a.rs` and `README.md` modified, `src/new.rs` staged.
///
/// - newest: adds `src/c.rs`
/// - middle: adds `docs/guide.md`
/// - oldest: adds `src/a.rs`, `src/b.rs`, `README.md`
fn repository() -> TempRepo {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("tuig-files-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    for (path, message) in [
        ("src/a.rs", "one"),
        ("docs/guide.md", "two"),
        ("src/c.rs", "three"),
    ] {
        if message == "one" {
            write(&dir, "src/b.rs", "b\n");
            write(&dir, "README.md", "readme\n");
        }
        write(&dir, path, "x\n");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", message]);
    }
    write(&dir, "src/a.rs", "changed\n");
    write(&dir, "README.md", "changed\n");
    write(&dir, "src/new.rs", "new\n");
    git(&dir, &["add", "src/new.rs"]);
    TempRepo(dir)
}

struct Harness {
    app: TestApp,
    shell: Rc<RefCell<Shell>>,
    repo: TempRepo,
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
    }

    /// What `update` does after every message: resolve the selection after a direct call like `move_file`.
    fn settle(&self) {
        self.shell.borrow_mut().settle_files(self.app.app());
    }

    fn read<R>(&self, read: impl FnOnce(&Shell) -> R) -> R {
        read(&self.shell.borrow())
    }

    fn refresh(&self) {
        self.wait("an idle snapshot slot", |shell| {
            !shell.tasks.snapshot.busy()
        });
        self.shell
            .borrow_mut()
            .request_refresh(self.app.app(), false);
        self.wait("the refresh", |shell| !shell.tasks.snapshot.busy());
    }

    /// Clicks the history row of commit `index` (0 is the newest).
    fn open_commit(&self, index: usize) {
        self.update(Msg::HistoryClick {
            row: index + 1,
            part: ClickPart::Row,
            clicks: 1,
        });
    }

    fn selected_path(&self) -> Option<String> {
        self.shell
            .borrow()
            .files
            .selected
            .as_ref()
            .map(|file| file.path.clone())
    }

    fn rows(&self, kind: ListKind) -> Vec<(String, usize, bool)> {
        self.shell
            .borrow_mut()
            .files
            .rows(kind)
            .iter()
            .map(|row| (row.path.clone(), row.depth, row.directory))
            .collect()
    }

    fn commit_paths(&self) -> Option<Vec<String>> {
        self.shell
            .borrow()
            .files
            .commit
            .files
            .as_ref()
            .map(|files| files.iter().map(|file| file.path.clone()).collect())
    }
}

#[test]
fn the_working_changes_open_with_the_first_unstaged_file_selected() {
    let h = Harness::new();
    h.wait("the file lists", |shell| !shell.files.unstaged.is_empty());
    h.settle();
    // `git status` order, as `fileIndex` 0 in TS. The tree lists `src/a.rs` first.
    assert_eq!(h.selected_path().as_deref(), Some("README.md"));
    let selected = h.shell.borrow().files.selected.clone().unwrap();
    assert_eq!(selected.source, FileSource::WorkingUnstaged);
    // Tree order: the directory first, then its file, then the top-level file.
    assert_eq!(
        h.rows(ListKind::Unstaged),
        [
            ("src".to_string(), 0, true),
            ("src/a.rs".to_string(), 1, false),
            ("README.md".to_string(), 0, false),
        ]
    );
}

#[test]
fn the_selection_follows_its_file_through_a_refresh_and_moves_when_the_file_is_gone() {
    let h = Harness::new();
    h.settle();
    h.shell.borrow_mut().move_file(h.app.app(), 1);
    h.settle();
    assert_eq!(h.selected_path().as_deref(), Some("README.md"));

    // A new file above the selection changes its row but not its identity.
    write(&h.repo.0, "src/b.rs", "changed\n");
    h.refresh();
    assert_eq!(h.rows(ListKind::Unstaged).len(), 4);
    assert_eq!(h.selected_path().as_deref(), Some("README.md"));

    // Reverting the selected file leaves the selection on a file that still exists.
    git(&h.repo.0, &["checkout", "--", "README.md"]);
    h.refresh();
    let path = h.selected_path().expect("a file stays selected");
    assert_ne!(path, "README.md");
    assert!(h.rows(ListKind::Unstaged).iter().any(|row| row.0 == path));
}

#[test]
fn switching_section_selects_the_first_file_in_status_order_not_tree_order() {
    let h = Harness::new();
    h.settle();
    h.shell.borrow_mut().files_toggle_mode();
    h.settle();
    assert_eq!(h.selected_path().as_deref(), Some("src/new.rs"));

    // The tree lists `src/a.rs` first, and `git status` lists `README.md` first. TS selects by the flat list.
    h.shell.borrow_mut().files_toggle_mode();
    h.settle();
    assert_eq!(h.selected_path().as_deref(), Some("README.md"));
}

#[test]
fn a_collapsed_directory_stays_collapsed_when_the_files_change() {
    let h = Harness::new();
    h.settle();
    let before = h.rows(ListKind::Unstaged).len();
    h.update(Msg::FileClick {
        section: ListKind::Unstaged,
        row: 0,
    });
    assert_eq!(
        h.rows(ListKind::Unstaged).len(),
        before - 1,
        "src collapsed"
    );

    write(&h.repo.0, "src/b.rs", "changed\n");
    write(&h.repo.0, "docs/guide.md", "changed\n");
    h.refresh();
    let rows = h.rows(ListKind::Unstaged);
    assert!(
        !rows.iter().any(|row| row.0 == "src/b.rs"),
        "the user's collapse survives the refresh"
    );
    assert!(
        rows.iter().any(|row| row.0 == "docs/guide.md"),
        "a directory seen for the first time opens"
    );
    // Clicking a directory does not move the selection or open a file.
    assert_eq!(h.selected_path().as_deref(), Some("README.md"));
}

#[test]
fn a_selection_hidden_in_a_collapsed_directory_steps_from_its_place_in_the_flat_order() {
    let h = Harness::new();
    write(&h.repo.0, "docs/guide.md", "changed\n");
    write(&h.repo.0, "src/b.rs", "changed\n");
    h.refresh();
    h.settle();
    let flat: Vec<String> = h.read(|shell| {
        shell
            .files
            .unstaged
            .iter()
            .map(|f| f.path.clone())
            .collect()
    });
    assert_eq!(flat, ["README.md", "docs/guide.md", "src/a.rs", "src/b.rs"]);

    h.shell.borrow_mut().files.selected_path = Some("src/a.rs".to_string());
    let src = h
        .rows(ListKind::Unstaged)
        .iter()
        .position(|row| row.0 == "src" && row.2)
        .unwrap();
    h.update(Msg::FileClick {
        section: ListKind::Unstaged,
        row: src,
    });
    let visible: Vec<String> = h
        .rows(ListKind::Unstaged)
        .into_iter()
        .map(|row| row.0)
        .collect();
    assert_eq!(visible, ["docs", "docs/guide.md", "src", "README.md"]);
    assert_eq!(h.selected_path().as_deref(), Some("src/a.rs"));

    // The tree order ends at README.md, but the flat order puts docs/guide.md next to the hidden file.
    h.shell.borrow_mut().move_file(h.app.app(), -1);
    h.settle();
    assert_eq!(h.selected_path().as_deref(), Some("docs/guide.md"));

    // From the end of the flat order, the nearest visible file is still docs/guide.md.
    h.shell.borrow_mut().files.selected_path = Some("src/b.rs".to_string());
    h.shell.borrow_mut().move_file(h.app.app(), 1);
    h.settle();
    assert_eq!(h.selected_path().as_deref(), Some("docs/guide.md"));
}

#[test]
fn a_commit_opens_its_files_and_a_superseded_load_is_dropped() {
    let h = Harness::new();
    h.settle();
    h.open_commit(0);
    let first = h.shell.borrow().tasks.commit_files.current();
    h.open_commit(1);
    let sha = h
        .shell
        .borrow()
        .history
        .selected_sha()
        .map(str::to_owned)
        .unwrap();

    // The first request finished after the second started.
    let stale = vec![ChangedFile {
        path: "stale.txt".into(),
        original_path: None,
        state: tuig_git::types::FileState::Added,
        staged: false,
        unstaged: false,
        submodule: None,
    }];
    h.update(Msg::CommitFiles(first, Ok(stale)));
    assert_eq!(h.commit_paths(), None);

    h.wait("the files of the second commit", |shell| {
        shell.files.commit.files.is_some()
    });
    assert_eq!(h.commit_paths(), Some(vec!["docs/guide.md".to_string()]));
    let selected = h.shell.borrow().files.selected.clone().unwrap();
    assert_eq!(selected.path, "docs/guide.md");
    assert_eq!(selected.source, FileSource::Commit(sha));
}

#[test]
fn the_selected_commit_file_survives_a_refresh_without_reloading() {
    let h = Harness::new();
    h.settle();
    h.open_commit(2);
    h.wait("the commit files", |shell| {
        shell.files.commit.files.is_some()
    });
    assert_eq!(h.selected_path().as_deref(), Some("README.md"));
    h.shell.borrow_mut().move_file(h.app.app(), -1);
    h.settle();
    let before = h.selected_path();
    assert_eq!(before.as_deref(), Some("src/b.rs"));

    h.refresh();
    assert!(
        !h.shell.borrow().tasks.commit_files.busy(),
        "a commit's files do not change, so a refresh keeps them"
    );
    assert_eq!(h.selected_path(), before);
}

#[test]
fn escape_returns_to_the_working_changes() {
    let h = Harness::new();
    h.settle();
    h.open_commit(0);
    h.wait("the commit files", |shell| {
        shell.files.commit.files.is_some()
    });
    h.update(Msg::Key(KeyEvent::new(KeyCode::Escape, Modifiers::NONE)));
    h.read(|shell| {
        assert_eq!(shell.files.contents, Contents::Working);
        assert_eq!(shell.history.selection, HistorySelection::Working);
    });
    assert_eq!(
        h.shell
            .borrow()
            .files
            .selected
            .as_ref()
            .map(|f| f.source.clone()),
        Some(FileSource::WorkingUnstaged)
    );
}

#[test]
fn rapid_selection_changes_load_only_the_last_commit_after_the_debounce() {
    let h = Harness::new();
    h.settle();
    h.shell.borrow_mut().files.debounce = Duration::from_millis(50);
    h.open_commit(0);
    h.open_commit(1);
    assert!(
        !h.shell.borrow().tasks.commit_files.busy(),
        "nothing loads before the debounce ends"
    );
    h.app.advance(Duration::from_millis(50));
    h.wait("the files", |shell| shell.files.commit.files.is_some());
    assert_eq!(h.commit_paths(), Some(vec!["docs/guide.md".to_string()]));
}
