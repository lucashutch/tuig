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
    harness.wait("the first snapshot", |shell| shell.snapshot_complete());
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
        shell.repo.root() == first && shell.snapshot_complete()
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
    harness.wait("the second snapshot", |shell| shell.snapshot_complete());
    let first_id = harness.read(|shell| shell.header.tabs[0].id.clone());
    harness.with(|shell, app| shell.activate_tab(app, &first_id));
    // The first tab shows what it kept. Nothing of the second repository may show.
    harness.read(|shell| {
        let first_root = shell.header.tabs[0].repo.root();
        assert_eq!(shell.snapshot.as_ref().unwrap().root, first_root);
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
        shell.snapshot_complete()
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

#[test]
fn a_tab_keeps_its_history_position_when_you_switch_away_and_back() {
    let harness = Harness::start(
        crate::screens::test_support::repository(120),
        Services::default(),
    );
    harness.wait("the first snapshot", |shell| shell.snapshot_complete());
    harness.wait("the head commit", |shell| {
        shell.history.selected_sha().is_some()
    });
    // The tab opens at HEAD. Move the selection down the list, which also scrolls it.
    for _ in 0..100 {
        harness.app.press("down");
    }
    let (sha, start) = harness.read(|shell| {
        (
            shell.history.selected_sha().unwrap().to_owned(),
            shell.history.viewport.start,
        )
    });
    assert!(start > 0, "the list scrolled");

    let other = repository();
    harness.open_path(&other.0);
    harness.wait("the second tab", |shell| {
        shell.repo.root().contains(other.0.to_str().unwrap()) && shell.snapshot_complete()
    });
    let first = harness.read(|shell| shell.header.tabs[0].id.clone());
    harness.with(|shell, app| shell.activate_tab(app, &first));
    harness.wait("the first tab again", |shell| {
        shell.snapshot_complete() && shell.history.selected_sha().is_some()
    });
    harness.read(|shell| {
        assert_eq!(shell.history.selected_sha(), Some(sha.as_str()));
        assert_eq!(shell.history.viewport.start, start);
        assert!(shell.history.focus_sha.is_none(), "no jump back to HEAD");
    });
}

#[test]
fn the_window_title_names_the_active_repository_and_follows_a_tab_switch() {
    use opentui::app::{HeadlessOptions, HeadlessWrite};
    use std::cell::RefCell;
    use std::rc::Rc;

    let app = App::headless(HeadlessOptions::default()).unwrap();
    let titles = Rc::new(RefCell::new(Vec::new()));
    {
        let titles = titles.clone();
        app.on_headless_write(move |_, write| {
            if let HeadlessWrite::Title(title) = write {
                titles.borrow_mut().push(title.clone());
            }
        });
    }
    let (first, second) = (repository(), repository());
    let open = |dir: &TempDir| -> Arc<dyn GitRepository> {
        Arc::new(
            app.runtime()
                .block_on(GitRepositoryService::open(&dir.0))
                .unwrap(),
        )
    };
    let (first_repo, second_repo) = (open(&first), open(&second));
    let roots = [first_repo.root().to_owned(), second_repo.root().to_owned()];
    let shell = Shell::start_with(&app, first_repo.clone(), Services::default());
    shell.borrow_mut().restore_tabs(TabsInit {
        repositories: vec![first_repo, second_repo],
        submodules: BTreeMap::new(),
        recent: Vec::new(),
        session_path: None,
    });
    let second_tab = shell.borrow().header.tabs[1].id.clone();
    let switching = shell.clone();
    // A timer closure need not be `Send`, unlike a proxy task. It runs inside the running loop.
    app.set_timeout(std::time::Duration::from_millis(10), move |cx| {
        switching.borrow_mut().activate_tab(cx.app(), &second_tab);
        cx.app().quit();
    });
    app.run().unwrap();
    assert_eq!(
        *titles.borrow(),
        [
            format!("tuig · {}", roots[0]),
            format!("tuig · {}", roots[1])
        ]
    );
}

#[test]
fn directory_suggestions_are_read_off_the_ui_thread_and_only_the_latest_input_counts() {
    let harness = start();
    let parent = TempDir::new("suggest");
    for name in ["alpha", "beta"] {
        std::fs::create_dir(parent.0.join(name)).unwrap();
    }
    harness.with(|shell, app| shell.show_repository_picker(app));
    let typed = |text: String| {
        harness.with(|shell, app| {
            shell.widgets.header.picker_input.set_value(text);
            shell.header_msg(app, HeaderMsg::PickerInput);
        });
    };
    let base = format!("{}/", parent.0.display());
    typed(format!("{base}a"));
    // The read has not reached the UI thread, so nothing changed yet.
    harness.read(|shell| assert!(shell.header.picker.as_ref().unwrap().suggestions.is_empty()));
    typed(format!("{base}b"));
    harness.wait("the suggestions", |shell| {
        !shell.header.picker.as_ref().unwrap().suggestions.is_empty()
    });
    harness.read(|shell| {
        let names: Vec<&str> = shell
            .header
            .picker
            .as_ref()
            .unwrap()
            .suggestions
            .iter()
            .map(|suggestion| suggestion.name.as_str())
            .collect();
        assert_eq!(names, ["beta"], "the answer for `a` was dropped");
    });
}

/// Opens a second repository and returns the id of the first tab, with the second tab active and loaded.
fn leave_first_tab(harness: &Harness, other: &TempDir) -> String {
    harness.open_path(&other.0);
    harness.wait("the second tab", |shell| {
        shell.repo.root().contains(other.0.to_str().unwrap()) && shell.snapshot_complete()
    });
    harness.read(|shell| shell.header.tabs[0].id.clone())
}

#[test]
fn switching_back_to_a_tab_shows_its_last_state_before_git_answers() {
    let harness = start();
    std::fs::write(harness._repo.0.join("new.txt"), "new\n").unwrap();
    harness.with(|shell, app| shell.request_refresh(app, false));
    harness.wait("the working file", |shell| shell.has_working());
    let (commits, files) = harness.read(|shell| {
        let shas: Vec<String> = shell
            .history
            .commits
            .iter()
            .map(|c| c.sha.clone())
            .collect();
        (shas, shell.snapshot.as_ref().unwrap().files.clone())
    });
    let other = repository();
    let first = leave_first_tab(&harness, &other);

    harness.with(|shell, app| shell.activate_tab(app, &first));
    // No message has been handled since the switch, so this is the kept state.
    harness.read(|shell| {
        let shas: Vec<String> = shell
            .history
            .commits
            .iter()
            .map(|c| c.sha.clone())
            .collect();
        assert_eq!(shas, commits);
        assert_eq!(shell.snapshot.as_ref().unwrap().files, files);
        assert!(
            shell.tasks.snapshot.busy(),
            "a refresh runs in the background"
        );
    });
}

#[test]
fn a_refresh_after_switching_back_updates_the_tab_and_keeps_the_selection() {
    let harness = start();
    harness.wait("the head commit", |shell| {
        shell.history.selected_sha().is_some()
    });
    harness.shell.borrow_mut().move_commit(1);
    let selected = harness.read(|shell| shell.history.selected_sha().unwrap().to_owned());
    let other = repository();
    let first = leave_first_tab(&harness, &other);
    git(
        &harness._repo.0,
        &["commit", "-q", "--allow-empty", "-m", "three"],
    );

    harness.with(|shell, app| shell.activate_tab(app, &first));
    assert_eq!(harness.read(|shell| shell.history.commits.len()), 2);
    harness.wait("the refreshed history", |shell| {
        !shell.tasks.snapshot.busy() && shell.history.commits.len() == 3
    });
    harness.read(|shell| {
        assert_eq!(shell.history.selected_sha(), Some(selected.as_str()));
        assert_eq!(shell.history.commits[0].subject, "three");
    });
}

#[test]
fn a_result_for_the_tab_you_left_does_not_land_in_the_new_one() {
    let harness = start();
    let other = repository();
    let first = leave_first_tab(&harness, &other);
    harness.with(|shell, app| shell.activate_tab(app, &first));
    let stale = harness.read(|shell| shell.tasks.snapshot.current());
    let second = harness.read(|shell| shell.header.tabs[1].id.clone());
    harness.with(|shell, app| shell.activate_tab(app, &second));
    let mut wrong = harness.read(|shell| shell.snapshot.clone().unwrap());
    wrong.root = "/wrong".to_owned();
    harness.with(|shell, app| shell.update(app, Msg::Snapshot(stale, Ok(wrong))));
    harness.read(|shell| {
        assert!(
            shell
                .snapshot
                .as_ref()
                .unwrap()
                .root
                .contains(other.0.to_str().unwrap())
        );
    });
}

#[test]
fn a_tab_left_before_status_lands_is_not_cached_as_clean() {
    let harness = start();
    std::fs::write(harness._repo.0.join("new.txt"), "new\n").unwrap();
    harness.with(|shell, app| shell.request_refresh(app, false));
    harness.wait("the working file", |shell| shell.has_working());
    // Put the first tab back in its first-load state: history shown, status pending.
    harness.with(|shell, _| {
        // A refresh still in flight would land during the tab switch and replace this state.
        shell.tasks.snapshot.cancel();
        let mut snapshot = shell.take_snapshot_for_cache().unwrap();
        let head = tuig_git::types::HistoryHead {
            root: snapshot.root.clone(),
            head_sha: snapshot.head_sha.clone(),
            branch: snapshot.branch.clone(),
            branches: std::mem::take(&mut snapshot.branches),
            stashes: Vec::new(),
            commits: std::mem::take(&mut snapshot.commits),
            commits_complete: snapshot.commits_complete,
        };
        shell.history_head_loaded(head);
        assert!(shell.files.working_loading);
    });
    let other = repository();
    let first = leave_first_tab(&harness, &other);

    harness.with(|shell, app| shell.activate_tab(app, &first));
    // A kept snapshot would show here with no files. The tab loads from scratch instead.
    harness.read(|shell| assert!(shell.snapshot.is_none()));
    harness.wait("the first tab to load", |shell| shell.has_working());
    harness.read(|shell| assert!(!shell.files.working_loading));
}
