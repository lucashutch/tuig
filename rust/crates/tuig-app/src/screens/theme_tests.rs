//! Theme choice, custom theme files, light, dark and system modes, and persistence, driven through `TestApp`. The
//! painting of each theme is covered by the parity scenario `theme`.

use super::*;
use crate::screens::palette::PalettePage;
use crate::screens::test_support::{Harness, TempDir, repository};
use crate::services::Services;
use crate::shell::Msg;
use opentui::prelude::Color;
use serde_json::json;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::themes::opencode_document;

fn rgb(text: &str) -> Rgba {
    Rgba::parse(text).unwrap()
}

fn config_with_theme(name: &str, background: &str) -> TempDir {
    let config = TempDir::new("theme-config");
    let mut document = opencode_document().clone();
    document["base"]["background"]["base"] = json!(background);
    let themes = config.0.join("themes");
    std::fs::create_dir_all(&themes).unwrap();
    std::fs::write(themes.join(format!("{name}.json")), document.to_string()).unwrap();
    config
}

fn start(config: &TempDir) -> Harness {
    let services = Services {
        theme_config: Some(config.0.clone()),
        ..Services::default()
    };
    let h = Harness::start(repository(3), services);
    h.wait("the first snapshot", |shell| shell.snapshot.is_some());
    h
}

fn run(h: &Harness, change: impl FnOnce(&mut Shell, &App)) {
    let mut shell = h.shell.borrow_mut();
    change(&mut shell, h.app.app());
    shell.sync(h.app.app());
}

fn active(h: &Harness) -> Theme {
    h.shell.borrow().themes.theme.clone()
}

fn selection(h: &Harness) -> ThemeSelection {
    h.shell.borrow().themes.selection.clone()
}

/// Opens a picker page and moves to the row whose id is `id`, so the preview shows.
fn highlight(h: &Harness, page: PalettePage, id: &str) {
    run(h, |shell, app| shell.show_theme_picker(app, page));
    for _ in 0..40 {
        let found = h.read(|shell| {
            let palette = shell.overlay.palette.as_ref().unwrap();
            palette.matches[palette.index as usize].id == id
        });
        if found {
            return;
        }
        run(h, |shell, _| shell.palette_move(1));
    }
    panic!("no picker row {id}");
}

fn choose(h: &Harness, page: PalettePage, id: &str) {
    highlight(h, page, id);
    run(h, |shell, app| shell.palette_activate(app));
}

/// The background of an empty cell of the history pane, below its three commits.
fn history_background(h: &Harness) -> Color {
    h.app.render().cell(100, 40).unwrap().bg
}

fn use_mode(h: &Harness, mode: &str) {
    choose(h, PalettePage::ThemeMode, &format!("theme-mode.{mode}"));
}

#[test]
fn a_custom_theme_file_shows_in_the_picker_and_recolors_the_screen_at_once() {
    let config = config_with_theme("mine", "#123456");
    let h = start(&config);
    let before = history_background(&h);
    assert_ne!(before, Color::rgb(0x12, 0x34, 0x56));

    run(&h, |shell, app| {
        shell.show_theme_picker(app, PalettePage::Themes)
    });
    let titles: Vec<String> = h.read(|shell| {
        let palette = shell.overlay.palette.as_ref().unwrap();
        palette
            .matches
            .iter()
            .map(|row| row.title.clone())
            .collect()
    });
    assert!(titles.contains(&"mine".to_owned()), "{titles:?}");
    assert!(
        titles.contains(&"one-dark (current)".to_owned()),
        "{titles:?}"
    );
    run(&h, |shell, app| shell.close_palette(app, true));

    choose(&h, PalettePage::Themes, "theme.mine");
    assert_eq!(active(&h).bg, rgb("#123456"));
    assert_eq!(history_background(&h), Color::rgb(0x12, 0x34, 0x56));
    assert_eq!(selection(&h).name, "mine");
}

#[test]
fn the_picker_previews_a_theme_and_dismissing_it_restores_the_old_one() {
    let config = config_with_theme("mine", "#123456");
    let h = start(&config);
    let original = active(&h);

    highlight(&h, PalettePage::Themes, "theme.mine");
    assert_eq!(active(&h).bg, rgb("#123456"));
    assert_eq!(selection(&h).name, "one-dark", "a preview keeps the choice");

    run(&h, |shell, app| shell.close_palette(app, true));
    assert_eq!(active(&h), original);
    assert!(
        !config.0.join("theme.json").exists(),
        "a preview saves nothing"
    );
}

#[test]
fn light_dark_and_system_modes_pick_the_matching_palette() {
    let config = TempDir::new("theme-modes");
    let h = start(&config);
    choose(&h, PalettePage::Themes, "theme.opencode");
    let dark_bg = active(&h).bg;

    use_mode(&h, "light");
    let light_bg = active(&h).bg;
    assert_ne!(light_bg, dark_bg);

    use_mode(&h, "dark");
    assert_eq!(active(&h).bg, dark_bg);

    // The system mode follows the terminal, and the fixed modes ignore it.
    use_mode(&h, "system");
    h.send(Msg::TerminalAppearance(ThemeMode::Light));
    assert_eq!(active(&h).bg, light_bg);
    h.send(Msg::TerminalAppearance(ThemeMode::Dark));
    assert_eq!(active(&h).bg, dark_bg);
    use_mode(&h, "dark");
    h.send(Msg::TerminalAppearance(ThemeMode::Light));
    assert_eq!(active(&h).bg, dark_bg);
}

#[test]
fn the_terminal_appearance_at_start_picks_the_system_palette() {
    let config = TempDir::new("theme-system-start");
    save_theme_preferences_to(
        &config.0,
        &ThemeSelection {
            name: "opencode".to_owned(),
            mode: ThemeModeSelection::System,
        },
    )
    .unwrap();
    let bg = |appearance| {
        ThemeState::load(Some(&config.0), None, appearance)
            .state
            .theme
            .bg
    };
    assert_ne!(bg(Some(ThemeMode::Light)), bg(Some(ThemeMode::Dark)));
    // A terminal that does not answer counts as dark.
    assert_eq!(bg(None), bg(Some(ThemeMode::Dark)));
}

#[test]
fn the_choice_is_saved_and_the_next_start_uses_it() {
    let config = config_with_theme("mine", "#123456");
    let h = start(&config);
    choose(&h, PalettePage::Themes, "theme.mine");
    use_mode(&h, "light");

    let saved = load_theme_preferences_from(&config.0).unwrap();
    assert_eq!(
        saved,
        ThemeSelection {
            name: "mine".to_owned(),
            mode: ThemeModeSelection::Light,
        }
    );

    let restarted = ThemeState::load(Some(&config.0), None, None);
    assert_eq!(restarted.warning, None);
    assert_eq!(restarted.state.selection, saved);
    assert_eq!(restarted.state.theme.bg, rgb("#123456"));
}

#[test]
fn a_broken_theme_file_falls_back_to_one_dark_and_says_why() {
    let config = TempDir::new("theme-broken");
    std::fs::write(config.0.join("theme.json"), "{not json").unwrap();
    let initial = ThemeState::load(Some(&config.0), None, None);
    assert_eq!(initial.state.theme, one_dark_theme());
    let warning = initial.warning.expect("a warning");
    assert!(warning.contains("Using One Dark"), "{warning}");

    std::fs::write(
        config.0.join("theme.json"),
        r#"{"name":"gone","mode":"dark"}"#,
    )
    .unwrap();
    let initial = ThemeState::load(Some(&config.0), None, None);
    assert_eq!(initial.state.theme, one_dark_theme());
    assert!(initial.warning.unwrap().contains("Unknown theme: gone"));
}
