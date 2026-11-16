use super::*;
use opentui::testing::TestApp;
use tuig_ui_model::theme::one_dark_theme;

fn row(footer: Footer, width: u16) -> (String, TestApp) {
    let app = TestApp::new(width, 1);
    let widget = Custom::new(&app, footer).width(u32::from(width)).height(1);
    app.root().add(&widget);
    let capture = app.render();
    (capture.row(0).to_string(), app)
}

#[test]
fn hints_follow_the_focus_and_the_composer() {
    let rest = HintContext::default();
    assert_eq!(
        format_hints(&rest),
        "j/k move  ·  ←/→ pan graph  ·  ↵ open commit  ·  / filter branches  ·  ⇥ pane  ·  [ ] collapse  ·  r refresh  ·  q quit"
    );
    let composing = HintContext {
        composing: true,
        focus: HintFocus::Changes,
        ..rest
    };
    assert_eq!(
        format_hints(&composing),
        "↵ commit  ·  ⇥ summary/description  ·  esc cancel"
    );
    // A line selection wins over the pane hints, and the action follows the section.
    let selecting = HintContext {
        line_selection: Some((3, true)),
        ..rest
    };
    assert!(format_hints(&selecting).starts_with("3 lines selected  ·  ↵ unstage  ·"));
    let empty = HintContext {
        line_selection: Some((0, false)),
        ..rest
    };
    assert_eq!(format_hints(&empty), format_hints(&rest));
}

#[test]
fn the_message_sits_at_the_right_and_the_hints_give_way() {
    let mut footer = Footer::new(one_dark_theme());
    footer.set_hints(&HintContext::default());
    footer.set_message("Copied abc123", MessageTone::Info);
    let (line, _app) = row(footer, 80);
    // The message ends one column before the edge. The hints are clipped with an ellipsis before it.
    assert!(line.ends_with("Copied abc123 "), "{line:?}");
    let message_start = line.find("Copied").unwrap();
    assert!(line[..message_start].trim_end().ends_with('…'), "{line:?}");
    assert!(line.starts_with(" j/k move"), "{line:?}");
}

#[test]
fn an_error_message_uses_the_deleted_color() {
    let theme = one_dark_theme();
    let mut footer = Footer::new(theme.clone());
    footer.set_message("boom", MessageTone::Error);
    let app = TestApp::new(40, 1);
    let widget = Custom::new(&app, footer).width(40).height(1);
    app.root().add(&widget);
    let capture = app.render();
    let cell = capture.cell(35, 0).unwrap();
    assert_eq!(cell.symbol, "b");
    assert_eq!(
        (cell.fg.r, cell.fg.g, cell.fg.b),
        (theme.deleted.r, theme.deleted.g, theme.deleted.b)
    );
}
