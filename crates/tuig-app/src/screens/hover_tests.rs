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
fn the_collapsed_sidebar_divider_hovers_without_painting_over_the_history() {
    let theme = one_dark_theme();
    let h = start(repository(3));
    let divider = h.read(|shell| shell.layout.panes.left_divider_left) as u16;
    h.app.click(divider, 20);
    h.wait("the fold", |shell| shell.layout.left_collapsed);
    h.app.render();
    let (left, width, bar) = h.read(|shell| {
        let panes = &shell.layout.panes;
        (
            panes.left_divider_left,
            panes.left_divider_width,
            panes.left_divider_bar_left,
        )
    });
    // The collapsed hit box is three cells wide. Its third cell lies over the history.
    assert_eq!(width, 3, "hit box {left}..{}", left + width);
    let (bar, third) = (bar as u32, bar as u32 + 2);
    // The history header row has a background that differs from the sidebar color, so a backdrop that
    // reaches the third cell shows.
    const HEADER_ROW: u32 = 4;
    assert_ne!(background(&h, third, HEADER_ROW), color(theme.bg));
    let (bar_resting, history_resting) = (
        background(&h, bar, HEADER_ROW),
        background(&h, third, HEADER_ROW),
    );
    h.app.hover(third as u16, HEADER_ROW as u16);
    assert_eq!(background(&h, bar, HEADER_ROW), color(theme.hover));
    assert_eq!(background(&h, third, HEADER_ROW), history_resting);
    h.app.hover(100, 20);
    assert_eq!(background(&h, bar, HEADER_ROW), bar_resting);
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

#[test]
fn a_split_bar_hovers_only_inside_its_ts_hit_box() {
    let theme = one_dark_theme();
    let h = dirty();
    let frame = h.app.render();
    // The bar between the lists has a thick grip in the middle of the changes pane.
    let (grip_x, y) = (0..48)
        .find_map(|y| {
            (116..160u32).find_map(|x| {
                let cell = frame.cell(x, y)?;
                format!("{:?}", cell.symbol).contains('━').then_some((x, y))
            })
        })
        .expect("a split bar grip");
    let is_bar = |x: u32| {
        frame.cell(x, y).is_some_and(|cell| {
            let symbol = format!("{:?}", cell.symbol);
            symbol.contains('─') || symbol.contains('━')
        })
    };
    let left = (0..=grip_x)
        .rev()
        .take_while(|x| is_bar(*x))
        .last()
        .unwrap();
    let width = (left..160).take_while(|x| is_bar(*x)).count() as u32;
    let resting = background(&h, grip_x, y);
    assert_ne!(resting, color(theme.hover));

    // TS: the hit box starts at width / 4, spans max(5, width / 2) cells and covers the bar row and the row below.
    let inside = left + width / 4 + 1;
    let hit_end = left + width / 4 + (width / 2).max(5);
    for (x, row, hovered) in [
        (inside, y, true),
        (inside, y + 1, true),
        (hit_end - 1, y, true),
        (left + 1, y, false),
        (hit_end, y, false),
        (left + width - 1, y, false),
        (inside, y + 2, false),
        (inside, y - 1, false),
    ] {
        h.app.hover(60, 20);
        h.app.hover(x as u16, row as u16);
        let shown = background(&h, grip_x, y) == color(theme.hover);
        assert_eq!(
            shown,
            hovered,
            "pointer at {x},{row}, bar at {left}..{}",
            left + width
        );
    }
    h.app.hover(60, 20);
    assert_eq!(background(&h, grip_x, y), resting);
}

#[test]
fn a_split_bar_dragged_under_the_still_pointer_is_not_hovered() {
    let theme = one_dark_theme();
    let h = dirty();
    let frame = h.app.render();
    let (x, y) = (0..48)
        .find_map(|y| {
            (116..160u32).find_map(|x| {
                let cell = frame.cell(x, y)?;
                format!("{:?}", cell.symbol).contains('━').then_some((x, y))
            })
        })
        .expect("a split bar grip");
    // TS paints no hover after a drag, because it sets the hover only from pointer motion.
    h.app
        .mouse(MouseEventKind::Down(MouseButton::Left), x as u16, y as u16);
    h.app.mouse(
        MouseEventKind::Drag(MouseButton::Left),
        x as u16,
        y as u16 - 3,
    );
    h.app.mouse(
        MouseEventKind::Up(MouseButton::Left),
        x as u16,
        y as u16 - 3,
    );
    h.app.render();
    let frame = h.app.render();
    let (_, bar_y) = (0..48)
        .find_map(|row| {
            let cell = frame.cell(x, row)?;
            format!("{:?}", cell.symbol)
                .contains('━')
                .then_some((x, row))
        })
        .expect("the moved grip");
    assert_ne!(bar_y, y, "the drag must move the bar");
    assert_ne!(background(&h, x, bar_y), color(theme.hover));
    // Moving the pointer inside the hit box hovers it.
    h.app.hover(x as u16, bar_y as u16);
    assert_eq!(background(&h, x, bar_y), color(theme.hover));
}
