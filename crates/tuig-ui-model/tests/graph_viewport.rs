use tuig_ui_model::graph::GraphCell;
use tuig_ui_model::graph_viewport::{
    clamp_graph_scroll, graph_scroll_indicator, graph_window_cells, lane_visible,
    visible_graph_columns,
};

fn cells(count: usize) -> Vec<GraphCell> {
    (0..count)
        .map(|i| GraphCell {
            symbol: format!("{i:<2}"),
            color: "#ffffff".to_string(),
        })
        .collect()
}

#[test]
fn visible_columns_follow_the_pane_width() {
    assert_eq!(visible_graph_columns(4, 120, 20), 4);
    assert_eq!(visible_graph_columns(40, 120, 20), 17);
    assert_eq!(visible_graph_columns(40, 30, 20), 3);
}

#[test]
fn scroll_cannot_pan_past_the_hidden_lanes() {
    assert_eq!(clamp_graph_scroll(99, 10, 4), 6);
    assert_eq!(clamp_graph_scroll(-3, 10, 4), 0);
    assert_eq!(clamp_graph_scroll(2, 4, 4), 0);
}

#[test]
fn a_window_keeps_a_constant_width_and_reports_hidden_lanes() {
    let window = graph_window_cells(&cells(10), 3, 4, 10, "#888888");
    assert_eq!(window.cells.len(), 4);
    assert_eq!((window.hidden_left, window.hidden_right), (3, 3));
    assert_eq!(window.cells[0].symbol.trim(), "3");
    assert_eq!(window.cells[3].symbol.trim(), "6");
}

#[test]
fn short_rows_pad_out_to_the_window() {
    let window = graph_window_cells(&cells(2), 0, 5, 5, "#888888");
    assert_eq!(window.cells.len(), 5);
    assert_eq!(window.cells[4].symbol, "  ");
    assert_eq!(window.cells[4].color, "#888888");
    assert_eq!((window.hidden_left, window.hidden_right), (0, 0));
}

#[test]
fn only_lanes_inside_the_window_are_visible() {
    assert!(lane_visible(5, 3, 4, 10));
    assert!(lane_visible(3, 3, 4, 10));
    assert!(lane_visible(6, 3, 4, 10));
    assert!(!lane_visible(7, 3, 4, 10));
    assert!(!lane_visible(0, 3, 4, 10));
    assert!(lane_visible(0, 0, 4, 4));
}

#[test]
fn each_scroll_arrow_keeps_a_fixed_slot() {
    assert_eq!(graph_scroll_indicator(0, 0), "");
    assert_eq!(graph_scroll_indicator(0, 3), "  ▶");
    assert_eq!(graph_scroll_indicator(2, 0), "◀  ");
    assert_eq!(graph_scroll_indicator(2, 3), "◀ ▶");
}
