//! Hover highlights against the rendered screen. OpenTUI tells a widget when the pointer leaves it, and when a
//! frame puts it under a pointer that did not move (a popup closed). The highlight must follow both.

use crate::screens::test_support::{Harness, TempDir, repository};
use crate::services::Services;
use crate::shell::Msg;
use opentui::prelude::*;
use tuig_ui_model::theme::one_dark_theme;

fn start(dir: TempDir) -> Harness {
    let h = Harness::start(dir, Services::default());
    h.wait("the first snapshot", |shell| shell.snapshot.is_some());
    h.send(Msg::Resize(160, 48));
    // Hit testing uses the last rendered frame.
    h.app.render();
    h
}

/// A repository with an untracked file, so the working row and the Stage all button show.
fn dirty() -> Harness {
    let dir = repository(3);
    std::fs::write(dir.0.join("new.txt"), "x\n").unwrap();
    let h = Harness::start(dir, Services::default());
    h.wait("the working changes", |shell| {
        shell
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| !snapshot.files.is_empty())
    });
    h.send(Msg::Resize(160, 48));
    h.app.render();
    h
}

fn background(h: &Harness, x: u32, y: u32) -> Color {
    h.app.render().cell(x, y).expect("a cell").bg
}

fn color(rgba: tuig_ui_model::color::Rgba) -> Color {
    Color::rgba(rgba.r, rgba.g, rgba.b, rgba.a)
}

#[test]
fn a_toolbar_button_and_the_tab_strip_stop_highlighting_when_the_pointer_leaves() {
    let theme = one_dark_theme();
    let h = start(repository(3));
    // The Undo button, then the `+` button on the tab strip, then a history row away from both.
    let plus = h
        .app
        .render()
        .row(0)
        .chars()
        .position(|c| c == '+')
        .expect("the + button") as u32;
    for (x, y) in [(78, 1), (plus, 0)] {
        let resting = background(&h, x, y);
        h.app.hover(x as u16, y as u16);
        assert_eq!(background(&h, x, y), color(theme.hover), "hover at {x},{y}");
        h.app.hover(60, 20);
        assert_eq!(background(&h, x, y), resting, "left {x},{y}");
    }
}

#[test]
fn the_pane_dividers_take_the_hover_color_and_lose_it_on_leaving() {
    let theme = one_dark_theme();
    let h = start(repository(3));
    let divider = h.read(|shell| shell.layout.panes.left_divider_bar_left) as u32;
    let resting = background(&h, divider, 10);
    h.app.hover(divider as u16, 10);
    assert_eq!(background(&h, divider, 10), color(theme.hover));
    h.app.hover(100, 10);
    assert_eq!(background(&h, divider, 10), resting);
}

#[test]
fn stage_all_keeps_its_hover_color_under_the_pointer_and_loses_it_on_leaving() {
    let theme = one_dark_theme();
    let h = dirty();
    // The label sits on row 3 at the right of the details pane.
    let (x, y) = (150, 3);
    let resting = background(&h, x, y);
    assert_ne!(resting, color(theme.hover));
    h.app.hover(x as u16, y as u16);
    assert_eq!(background(&h, x, y), color(theme.hover));
    h.app.hover(60, 20);
    assert_eq!(background(&h, x, y), resting);
}

#[test]
fn the_row_under_the_pointer_is_highlighted_again_when_a_popup_closes() {
    let theme = one_dark_theme();
    let h = start(repository(12));
    // Right click a row for its menu, then leave the pointer over another row, away from the menu.
    for kind in [
        MouseEventKind::Down(MouseButton::Right),
        MouseEventKind::Up(MouseButton::Right),
    ] {
        h.app.mouse(kind, 60, 6);
    }
    h.wait("the menu", |shell| shell.overlay.is_open());
    h.app.render();
    h.app.hover(100, 14);
    assert_ne!(
        background(&h, 100, 14),
        color(theme.hover),
        "the layer covers the row"
    );
    h.app.press("escape");
    h.wait("the menu to close", |shell| !shell.overlay.is_open());
    // OpenTUI looks again at what is under the pointer once a frame has been presented.
    h.app.render();
    assert_eq!(background(&h, 100, 14), color(theme.hover));
    h.app.hover(130, 14);
    assert_ne!(background(&h, 100, 14), color(theme.hover));
}
