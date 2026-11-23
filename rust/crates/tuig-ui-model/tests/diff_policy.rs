use tuig_ui_model::diff_policy::{
    DIFF_HIGHLIGHT_MAX_BYTES, DIFF_HIGHLIGHT_MAX_LINES, can_highlight_diff,
};

#[test]
fn highlighting_stops_at_the_byte_limit() {
    assert!(can_highlight_diff(
        &"x".repeat(DIFF_HIGHLIGHT_MAX_BYTES - 1)
    ));
    assert!(!can_highlight_diff(&"x".repeat(DIFF_HIGHLIGHT_MAX_BYTES)));
}

#[test]
fn highlighting_stops_at_the_line_limit() {
    // N lines separated by N-1 newlines.
    let lines = |n: usize| vec![""; n].join("\n");
    assert!(can_highlight_diff(&lines(DIFF_HIGHLIGHT_MAX_LINES - 1)));
    assert!(!can_highlight_diff(&lines(DIFF_HIGHLIGHT_MAX_LINES)));
}
