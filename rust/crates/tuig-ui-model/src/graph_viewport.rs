//! Horizontal windowing of a wide graph. Ports `src/ui/graph-viewport.ts`.
//!
//! Difference from TypeScript: scroll offsets are `i64`, so the non-finite
//! number case of the JavaScript version does not exist.

use crate::graph::GraphCell;

/// Columns the graph keeps even in a very narrow history pane.
pub const MIN_GRAPH_COLUMNS: usize = 3;

/// Share of the history pane the graph may occupy before it stops growing.
const GRAPH_WIDTH_SHARE: f64 = 0.35;

/// Columns the graph window shows for a given history width.
pub fn visible_graph_columns(
    total_columns: usize,
    history_content_width: i64,
    label_width: i64,
) -> usize {
    let total = total_columns.max(1);
    let available = (history_content_width - label_width - 2).max(0);
    let budget = ((available as f64 * GRAPH_WIDTH_SHARE) / 2.0).floor() as usize;
    total.min(MIN_GRAPH_COLUMNS.max(budget)).max(1)
}

/// Clamp a horizontal graph offset to the scrollable range.
pub fn clamp_graph_scroll(scroll: i64, total_columns: usize, visible_columns: usize) -> usize {
    let max = total_columns.saturating_sub(visible_columns) as i64;
    scroll.clamp(0, max) as usize
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphWindow {
    pub cells: Vec<GraphCell>,
    /// Columns hidden to the left and right of the window.
    pub hidden_left: usize,
    pub hidden_right: usize,
}

/// Slice one row's cells to the visible window. The row width stays constant.
pub fn graph_window_cells(
    cells: &[GraphCell],
    scroll: i64,
    visible_columns: usize,
    total_columns: usize,
    marker_color: &str,
) -> GraphWindow {
    let visible = visible_columns.max(1);
    let offset = clamp_graph_scroll(scroll, total_columns, visible);
    let hidden_right = total_columns.saturating_sub(offset + visible);
    let window = (offset..offset + visible)
        .map(|column| {
            cells.get(column).cloned().unwrap_or_else(|| GraphCell {
                symbol: "  ".to_string(),
                color: marker_color.to_string(),
            })
        })
        .collect();
    GraphWindow {
        cells: window,
        hidden_left: offset,
        hidden_right,
    }
}

/// Whether a lane's dot is drawn inside the window.
pub fn lane_visible(
    lane: usize,
    scroll: i64,
    visible_columns: usize,
    total_columns: usize,
) -> bool {
    let visible = visible_columns.max(1);
    let offset = clamp_graph_scroll(scroll, total_columns, visible);
    lane >= offset && lane < offset + visible
}

/// Arrows for the graph column header, in fixed left and right slots. Empty
/// when nothing is hidden.
pub fn graph_scroll_indicator(hidden_left: usize, hidden_right: usize) -> String {
    if hidden_left == 0 && hidden_right == 0 {
        return String::new();
    }
    format!(
        "{} {}",
        if hidden_left > 0 { '◀' } else { ' ' },
        if hidden_right > 0 { '▶' } else { ' ' }
    )
}
