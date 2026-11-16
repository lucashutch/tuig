//! Repository tabs, the toolbar and the picker against real repositories, driven through `TestApp`. The painting is
//! covered by the parity scenarios and by the widget tests in `tuig-widgets`.

use super::*;
use crate::screens::test_support::{Harness, TempDir, git};
use crate::services::Services;
use std::sync::atomic::{AtomicUsize, Ordering};
use tuig_git::repository::GitRepositoryService;

/// A repository with commits `one` and `two` on `main`.
fn repository() -> TempDir {
    let dir = TempDir::new("tabs");
    git(&dir.0, &["init", "-q", "-b", "main"]);
    for name in ["one", "two"] {
        std::fs::write(dir.0.join("file.txt"), format!("{name}\n")).unwrap();
        git(&dir.0, &["add", "file.txt"]);
        git(&dir.0, &["commit", "-q", "-m", name]);
    }
    dir
}

fn head(dir: &TempDir) -> String {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&dir.0)
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn start() -> Harness {
    let harness = Harness::start(repository(), Services::default());
    harness.wait("the first snapshot", |shell| shell.snapshot.is_some());
    harness
}

fn session_file() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir().join(format!(
        "tuig-session-{}-{}.json",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ))
}

impl Harness {
    fn with<R>(&self, run: impl FnOnce(&mut Shell, &App) -> R) -> R {
        run(&mut self.shell.borrow_mut(), self.app.app())
    }

    fn open_path(&self, path: &Path) {
        self.shell
            .borrow_mut()
            .open_repository_path(self.app.app(), Some(path.to_string_lossy().into_owned()));
    }

    fn tab_roots(&self) -> Vec<String> {
        self.read(|shell| {
            shell
                .header
                .tabs
                .iter()
                .map(|tab| tab.repo.root().to_owned())
                .collect()
        })
    }
}

#[test]
fn opening_a_repository_adds_a_tab_and_shows_it() {
    let harness = start();
    let other = repository();
    harness.open_path(&other.0);
    harness.wait("the new tab to load", |shell| {
        shell.header.tabs.len() == 2
            && shell
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.root == shell.repo.root())
            && shell.repo.root().contains(other.0.to_str().unwrap())
    });
    harness.read(|shell| {
        assert_eq!(shell.header.active, shell.header.tabs[1].id);
        // The new tab opens at its checked-out commit.
        assert_eq!(
            shell
                .history
                .selected_sha()
                .map(str::to_owned)
                .or_else(|| shell.history.focus_sha.clone()),
            Some(head(&other))
        );
    });
}

#[test]
fn opening_an_open_repository_shows_its_tab_and_adds_none() {
    let harness = start();
    let other = repository();
    harness.open_path(&other.0);
    harness.wait("two tabs", |shell| shell.header.tabs.len() == 2);
    let first = harness.read(|shell| shell.header.tabs[0].repo.root().to_owned());
    harness.open_path(Path::new(&first));
    harness.wait("the first tab to be active again", |shell| {
        shell.repo.root() == first && shell.snapshot.is_some()
    });
    assert_eq!(harness.tab_roots().len(), 2);
}

#[test]
fn a_path_that_is_not_a_repository_shows_an_error_and_keeps_the_tabs() {
    let harness = start();
    let plain = TempDir::new("plain");
    harness.open_path(&plain.0);
    harness.wait("the error", |shell| {
        shell
            .notice
            .as_deref()
            .is_some_and(|text| text.starts_with("Not a Git repository"))
    });
    assert_eq!(harness.tab_roots().len(), 1);
}

#[test]
fn switching_tabs_drops_what_was_loaded_for_the_old_repository() {
    let harness = start();
    let other = repository();
    harness.open_path(&other.0);
    harness.wait("two tabs", |shell| {
        shell.header.tabs.len() == 2 && shell.repo.root().contains(other.0.to_str().unwrap())
    });
    harness.wait("the second snapshot", |shell| shell.snapshot.is_some());
    let first_id = harness.read(|shell| shell.header.tabs[0].id.clone());
    harness.with(|shell, app| shell.activate_tab(app, &first_id));
    // Until the first repository's snapshot arrives, nothing of the second one may show.
    harness.read(|shell| {
        assert!(shell.snapshot.is_none());
        assert!(shell.history.commits.is_empty());
    });
    harness.wait("the first repository to load", |shell| {
        shell.snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.root == shell.header.tabs[0].repo.root() && !shell.history.commits.is_empty()
        })
    });
}

#[test]
fn closing_the_active_tab_activates_its_neighbour_and_the_last_tab_stays() {
    let harness = start();
    let other = repository();
    harness.open_path(&other.0);
    harness.wait("two tabs", |shell| shell.header.tabs.len() == 2);
    let (first, second) = harness.read(|shell| {
        (
            shell.header.tabs[0].id.clone(),
            shell.header.tabs[1].id.clone(),
        )
    });
    harness.with(|shell, app| shell.close_tab(app, &second));
    harness.read(|shell| {
        assert_eq!(shell.header.tabs.len(), 1);
        assert_eq!(shell.header.active, first);
    });
    harness.wait("the first repository to load", |shell| {
        shell.snapshot.is_some()
    });
}

#[test]
fn the_session_file_lists_the_tabs_and_the_active_repository() {
    let harness = start();
    let path = session_file();
    harness.shell.borrow_mut().header.session_path = Some(path.clone());
    let other = repository();
    harness.open_path(&other.0);
    harness.wait("two tabs", |shell| shell.header.tabs.len() == 2);
    let saved = tuig_ui_model::session_preferences::load_session_preferences(&path);
    let _ = std::fs::remove_file(&path);
    assert_eq!(saved.repositories, harness.tab_roots());
    assert_eq!(
        saved.active_repository.as_deref(),
        Some(harness.tab_roots()[1].as_str())
    );
    assert_eq!(
        saved
            .recent_repositories
            .as_ref()
            .map(|recent| recent[0].clone()),
        Some(harness.tab_roots()[1].clone())
    );
}

#[test]
fn undo_asks_first_and_then_moves_head_back() {
    let harness = start();
    let before = head(&harness._repo);
    std::fs::write(harness._repo.0.join("file.txt"), "three\n").unwrap();
    git(&harness._repo.0, &["commit", "-q", "-am", "three"]);
    let after = head(&harness._repo);
    assert_ne!(before, after);
    harness.with(|shell, app| shell.run_toolbar_action(app, ToolbarAction::Undo));
    harness.wait("the confirmation", |shell| {
        shell
            .overlay
            .menu
            .as_ref()
            .is_some_and(|menu| menu.view.title == "Undo local history")
    });
    // The preview names the target and holds the mutation slot no longer.
    harness.read(|shell| {
        assert!(shell.diff.mutation.is_none());
        let lines: Vec<&str> = shell
            .overlay
            .menu
            .as_ref()
            .unwrap()
            .view
            .pane
            .items
            .iter()
            .map(|item| item.label.as_str())
            .collect();
        assert!(lines.iter().any(|line| line.contains("Action: commit")));
        assert!(lines.iter().any(|line| line.contains(short_sha(&before))));
    });
    // Nothing moved before the user confirmed.
    assert_eq!(head(&harness._repo), after);
    harness.with(|shell, app| shell.menu_activate(app));
    harness.wait("head to move back", |_| head(&harness._repo) == before);
}

#[test]
fn undo_that_is_cancelled_changes_nothing() {
    let harness = start();
    std::fs::write(harness._repo.0.join("file.txt"), "three\n").unwrap();
    git(&harness._repo.0, &["commit", "-q", "-am", "three"]);
    let after = head(&harness._repo);
    harness.with(|shell, app| shell.run_toolbar_action(app, ToolbarAction::Undo));
    harness.wait("the confirmation", |shell| shell.overlay.menu.is_some());
    harness.with(|shell, app| shell.close_popup(app));
    assert_eq!(head(&harness._repo), after);
}

#[test]
fn a_repository_session_restores_the_saved_order_and_active_tab() {
    let harness = start();
    let (a, b) = (repository(), repository());
    let open = |dir: &TempDir| -> Arc<dyn GitRepository> {
        Arc::new(
            harness
                .app
                .app()
                .runtime()
                .block_on(GitRepositoryService::open(&dir.0))
                .unwrap(),
        )
    };
    let active = harness.read(|shell| shell.repo.clone());
    harness.shell.borrow_mut().restore_tabs(TabsInit {
        repositories: vec![open(&a), active.clone(), open(&b)],
        submodules: BTreeMap::new(),
        recent: vec!["/elsewhere".to_owned()],
        session_path: None,
    });
    harness.read(|shell| {
        assert_eq!(shell.header.tabs.len(), 3);
        assert_eq!(shell.header.active, shell.header.tabs[1].id);
        assert_eq!(shell.header.recent[0], active.root());
    });
}
