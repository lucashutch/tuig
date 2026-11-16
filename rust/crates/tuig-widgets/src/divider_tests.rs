use super::*;
use opentui::testing::TestApp;
use tuig_ui_model::theme::one_dark_theme;

#[test]
fn the_bar_paints_a_heavy_grip_in_the_divider_color() {
    let theme = one_dark_theme();
    let app = TestApp::new(1, 12);
    let widget = Custom::new(&app, Divider::new(theme.clone()))
        .width(1)
        .height(12);
    app.root().add(&widget);
    let capture = app.render();
    let glyphs: String = (0..12)
        .map(|y| capture.cell(0, y).unwrap().symbol.chars().next().unwrap())
        .collect();
    assert_eq!(glyphs, "││││┃┃┃┃││││");
    let fg = capture.cell(0, 4).unwrap().fg;
    assert_eq!(
        (fg.r, fg.g, fg.b),
        (theme.divider.r, theme.divider.g, theme.divider.b)
    );
}
