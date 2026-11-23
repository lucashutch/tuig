use tuig_ui_model::history_viewport::{HistorySelection, HistoryViewport};

#[test]
fn wheel_scrolls_the_viewport_and_keeps_the_selection() {
    let mut viewport = HistoryViewport::default();
    let selected = 2;
    viewport.scroll(5, 100, 10, false);
    assert_eq!(viewport.resolve(selected, 100, 10), 5);
    // The selection is off screen, but a detached viewport does not jump back to it.
    viewport.scroll(200, 100, 10, false);
    assert_eq!(
        viewport.resolve(selected, 100, 10),
        90,
        "clamped to the last full page"
    );
    viewport.scroll(-500, 100, 10, false);
    assert_eq!(viewport.resolve(selected, 100, 10), 0);
}

#[test]
fn an_attached_viewport_follows_the_selection() {
    let mut viewport = HistoryViewport {
        start: 40,
        detached: false,
    };
    assert_eq!(viewport.resolve(3, 100, 10), 3);
    assert_eq!(
        viewport.resolve(30, 100, 10),
        21,
        "the selection lands on the last line"
    );
}

#[test]
fn click_lines_map_to_rows_below_the_header() {
    let mut viewport = HistoryViewport::default();
    viewport.scroll(7, 50, 10, false);
    assert_eq!(viewport.row_at_line(0, 50), None, "the header is not a row");
    assert_eq!(viewport.row_at_line(1, 50), Some(7));
    assert_eq!(viewport.row_at_line(10, 50), Some(16));
    assert_eq!(viewport.row_at_line(-3, 50), None);
    viewport.scroll(100, 50, 10, false);
    assert_eq!(viewport.row_at_line(11, 50), None, "past the last row");
}

#[test]
fn keyboard_moves_pass_through_the_working_row_only_at_the_top() {
    let commits = 5;
    let working = HistorySelection::Working;
    assert_eq!(working.moved(-1, true, commits), working);
    assert_eq!(working.moved(1, true, commits), HistorySelection::Commit(0));
    assert_eq!(
        HistorySelection::Commit(0).moved(-1, true, commits),
        working
    );
    assert_eq!(
        HistorySelection::Commit(0).moved(-1, false, commits),
        HistorySelection::Commit(0)
    );
    assert_eq!(
        HistorySelection::Commit(3).moved(10, true, commits),
        HistorySelection::Commit(4),
        "clamped to the last loaded commit"
    );
}

#[test]
fn the_next_page_loads_within_fifty_rows_of_the_end() {
    let viewport = HistoryViewport {
        start: 190,
        detached: true,
    };
    assert!(!viewport.wants_more(300, 40));
    assert!(viewport.wants_more(280, 40));
}
