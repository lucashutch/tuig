//! Menus, prompts and the palette against a real repository, driven through `TestApp`. The painting is covered by
//! the parity scenarios `graph-menu`, `diff-menu` and `command-palette`.

use super::*;
use crate::screens::popup::OverlayMsg;
use opentui::testing::TestApp;
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use tuig_git::repository::GitRepositoryService;
use tuig_ui_model::graph_menu::ConfirmRequest;
use tuig_ui_model::history_viewport::HistorySelection;
use tuig_widgets::files::ListKind;
use tuig_widgets::popup::PopupEvent;

const WAIT: Duration = Duration::from_secs(20);

struct TempRepo(PathBuf);

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Process::new("git")
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// Three commits touching `a.txt`, then an unstaged edit of `a.txt` and an untracked `b.txt`.
fn repository() -> TempRepo {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("tuig-popup-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    for i in 0..3 {
        std::fs::write(dir.join("a.txt"), format!("{i}\n")).unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", &format!("commit {i}")]);
    }
    std::fs::write(dir.join("a.txt"), "edited\n").unwrap();
    std::fs::write(dir.join("b.txt"), "new\n").unwrap();
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
        harness.wait("the first snapshot", |shell| {
            shell.snapshot_complete() && shell.history.focus_sha.is_none()
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

    fn with<R>(&self, run: impl FnOnce(&mut Shell, &App) -> R) -> R {
        run(&mut self.shell.borrow_mut(), self.app.app())
    }

    fn update(&self, msg: Msg) {
        self.with(|shell, app| shell.update(app, msg));
    }

    fn read<R>(&self, read: impl FnOnce(&Shell) -> R) -> R {
        read(&self.shell.borrow())
    }

    /// Clicks the menu row whose label is `label`, in the main pane or the open submenu.
    fn click_item(&self, label: &str) {
        let (x, y, submenu) = self.read(|shell| {
            let view = &shell.overlay.menu.as_ref().expect("a menu is open").view;
            [
                (&view.pane, false),
                (view.submenu.as_ref().unwrap_or(&view.pane), true),
            ]
            .into_iter()
            .find_map(|(pane, submenu)| {
                let row = pane.items.iter().position(|item| item.label == label)?;
                Some((pane.left + 2, pane.top + 1 + row as i64, submenu))
            })
            .unwrap_or_else(|| panic!("no menu item {label:?}"))
        });
        self.with(|shell, app| {
            shell.popup_event(
                app,
                PopupEvent::MenuClick {
                    x: x as u16,
                    y: y as u16,
                    submenu,
                },
            )
        });
    }

    fn hover_item(&self, label: &str) {
        let (x, y) = self.read(|shell| {
            let pane = &shell.overlay.menu.as_ref().unwrap().view.pane;
            let row = pane
                .items
                .iter()
                .position(|item| item.label == label)
                .unwrap();
            (pane.left + 2, pane.top + 1 + row as i64)
        });
        self.with(|shell, _| shell.menu_hover(x, y, false));
    }

    fn menu_open(&self) -> bool {
        self.read(|shell| shell.overlay.menu.is_some())
    }
}

fn confirm(shell: &mut Shell, ran: &Rc<Cell<bool>>) {
    let ran = ran.clone();
    shell.confirm_then(
        ConfirmRequest {
            title: "Sure".to_owned(),
            lines: vec!["Really?".to_owned()],
            confirm_label: "Do it".to_owned(),
            destructive: true,
        },
        move |_, _| ran.set(true),
    );
}

#[test]
fn a_confirmation_runs_only_when_the_confirm_item_is_chosen() {
    let h = Harness::new();
    let ran = Rc::new(Cell::new(false));

    h.with(|shell, _| confirm(shell, &ran));
    h.click_item("Cancel");
    assert!(!h.menu_open());
    assert!(!ran.get(), "Cancel does not run it");

    h.with(|shell, app| {
        confirm(shell, &ran);
        shell.overlay_key(app, &KeyEvent::from(KeyCode::Escape));
    });
    assert!(!h.menu_open());
    assert!(!ran.get(), "Esc does not run it");

    // The confirm item starts highlighted, so Enter takes it.
    h.with(|shell, app| {
        confirm(shell, &ran);
        shell.overlay_key(app, &KeyEvent::from(KeyCode::Enter));
    });
    assert!(!h.menu_open());
    assert!(ran.get());
}

#[test]
fn the_name_prompt_rejects_an_empty_name_and_passes_a_trimmed_one() {
    let h = Harness::new();
    let name = Rc::new(RefCell::new(None));
    let sink = name.clone();
    h.with(|shell, app| {
        shell.open_name_prompt(app, "Create tag", "tag name", move |_, _, value| {
            *sink.borrow_mut() = Some(value);
        })
    });
    h.read(|shell| assert!(shell.widgets.overlay.prompt.is_focused()));

    h.update(Msg::Overlay(OverlayMsg::PromptSubmit));
    assert!(h.menu_open(), "an empty name keeps the prompt open");
    assert_eq!(
        h.read(|shell| shell.notice.clone()).as_deref(),
        Some("A name is required")
    );

    h.read(|shell| shell.widgets.overlay.prompt.set_value("  v1.0  "));
    h.update(Msg::Overlay(OverlayMsg::PromptSubmit));
    assert!(!h.menu_open());
    assert_eq!(name.borrow().as_deref(), Some("v1.0"));
}

#[test]
fn a_commit_menu_resets_through_its_submenu() {
    let h = Harness::new();
    // Row 0 is the working row, row 1 the tip, row 2 the commit before it.
    h.update(Msg::Overlay(OverlayMsg::HistoryMenu {
        row: 2,
        on_label: false,
        x: 60,
        y: 6,
    }));
    assert_eq!(
        h.read(|shell| shell.history.selection),
        HistorySelection::Commit(1)
    );
    let target = h.read(|shell| shell.history.selected_sha().unwrap().to_owned());

    h.hover_item("Reset main to this commit");
    h.read(|shell| {
        let view = &shell.overlay.menu.as_ref().unwrap().view;
        assert_eq!(view.submenu.as_ref().map(|pane| pane.items.len()), Some(3));
    });
    h.click_item("Soft · keep index and working tree");
    assert!(!h.menu_open());
    h.wait("the reset", |shell| shell.diff.mutation.is_none());
    assert_eq!(git(&h.repo.0, &["rev-parse", "HEAD"]), target);
}

#[test]
fn a_menu_stays_open_when_a_submenu_parent_is_clicked() {
    let h = Harness::new();
    h.update(Msg::Overlay(OverlayMsg::HistoryMenu {
        row: 1,
        on_label: false,
        x: 60,
        y: 6,
    }));
    h.click_item("Reset main to this commit");
    assert!(h.menu_open());
    h.read(|shell| assert!(shell.overlay.menu.as_ref().unwrap().view.submenu.is_some()));
}

#[test]
fn the_file_menu_starts_the_file_history() {
    let h = Harness::new();
    h.update(Msg::Overlay(OverlayMsg::FileMenu {
        section: ListKind::Unstaged,
        row: 0,
        x: 120,
        y: 6,
    }));
    h.read(|shell| {
        let menu = shell.overlay.menu.as_ref().expect("a file menu");
        assert_eq!(menu.view.title, "a.txt");
    });
    h.click_item("Show file history");
    h.wait("the file history", |shell| {
        shell.details.file_history.is_some()
    });
    h.read(|shell| {
        let subjects: Vec<&str> = shell
            .details
            .file_history
            .as_ref()
            .unwrap()
            .commits
            .iter()
            .map(|commit| commit.subject.as_str())
            .collect();
        assert_eq!(subjects, ["commit 2", "commit 1", "commit 0"]);
    });
}

#[test]
fn the_file_menu_stages_the_file() {
    let h = Harness::new();
    h.update(Msg::Overlay(OverlayMsg::FileMenu {
        section: ListKind::Unstaged,
        row: 0,
        x: 120,
        y: 6,
    }));
    h.click_item("Stage a.txt");
    h.wait("staging", |shell| shell.diff.mutation.is_none());
    assert_eq!(
        git(&h.repo.0, &["diff", "--cached", "--name-only"]),
        "a.txt"
    );
}

fn palette_search(h: &Harness, query: &str) {
    h.read(|shell| shell.widgets.overlay.palette_input.set_value(query));
    h.update(Msg::Overlay(OverlayMsg::PaletteQuery));
}

fn palette_selection(h: &Harness) -> Option<String> {
    h.read(|shell| {
        let palette = shell.overlay.palette.as_ref()?;
        let index = usize::try_from(palette.index).ok()?;
        palette.matches.get(index).map(|command| command.id.clone())
    })
}

#[test]
fn the_palette_runs_the_selected_command_and_closes() {
    let h = Harness::new();
    h.with(|shell, app| shell.toggle_palette(app));
    palette_search(&h, "stage all");
    assert_eq!(palette_selection(&h).as_deref(), Some("changes.stage-all"));
    h.update(Msg::Overlay(OverlayMsg::PaletteSubmit));
    assert!(h.read(|shell| shell.overlay.palette.is_none()));
    h.wait("staging", |shell| shell.diff.mutation.is_none());
    let staged = git(&h.repo.0, &["diff", "--cached", "--name-only"]);
    assert_eq!(staged, "a.txt\nb.txt");
}

#[test]
fn palette_selection_skips_commands_that_are_not_available() {
    let h = Harness::new();
    h.with(|shell, app| shell.toggle_palette(app));
    // "Pop latest stash" is disabled because the repository has no stash.
    palette_search(&h, "stash");
    assert_eq!(palette_selection(&h).as_deref(), Some("repository.stash"));
    h.with(|shell, _| shell.palette_move(1));
    assert_eq!(
        palette_selection(&h).as_deref(),
        Some("changes.stage-all"),
        "the arrow steps over the disabled command in row 1"
    );
    // Row 1 is "Pop latest stash". Hover and click leave a disabled command alone.
    h.with(|shell, _| shell.palette_hover(1));
    assert_eq!(palette_selection(&h).as_deref(), Some("changes.stage-all"));
    h.with(|shell, app| shell.palette_click(app, 1, MouseButton::Left));
    assert!(h.read(|shell| shell.overlay.palette.is_some()));
}

#[test]
fn the_palette_and_menus_do_not_open_over_each_other() {
    let h = Harness::new();
    h.update(Msg::Overlay(OverlayMsg::HistoryMenu {
        row: 1,
        on_label: false,
        x: 60,
        y: 6,
    }));
    // Ctrl+P is ignored while a menu owns the keyboard.
    let consumed = h.with(|shell, app| {
        let key = KeyEvent::new(KeyCode::Char('p'), opentui::input::Modifiers::CTRL);
        shell.overlay_key(app, &key)
    });
    assert!(consumed);
    assert!(h.read(|shell| shell.overlay.palette.is_none()));
    h.with(|shell, app| shell.dismiss_overlay(app));
    h.with(|shell, app| shell.toggle_palette(app));
    assert!(h.read(|shell| shell.overlay.menu.is_none()));
    assert!(h.read(|shell| shell.overlay.palette.is_some()));
}
