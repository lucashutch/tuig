//! History pane column geometry. Ports `src/ui/history-columns.ts`.
//!
//! Widths are `i64` because the arithmetic can go negative in a narrow pane.

use crate::graph_viewport::visible_graph_columns;
use crate::preferences::HistoryColumnPreferences;

/// The header separators that resize a column when dragged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryDividerKey {
    BranchWidth,
    GraphWidth,
    CommitterWidth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HistoryColumns {
    pub branch_width: Option<i64>,
    pub graph_width: Option<i64>,
    pub committer_width: Option<i64>,
    pub show_committer: bool,
    pub show_sha: bool,
    /// Pull request column. `None` means shown.
    pub show_pr: Option<bool>,
}

impl HistoryColumns {
    /// Laid over the saved values, which replace only what the file defines. `restoreLayout`.
    pub fn with_saved(self, saved: &HistoryColumnPreferences) -> Self {
        let width = |saved: Option<u32>, current: Option<i64>| saved.map(i64::from).or(current);
        Self {
            branch_width: width(saved.branch_width, self.branch_width),
            graph_width: width(saved.graph_width, self.graph_width),
            committer_width: width(saved.committer_width, self.committer_width),
            show_committer: saved.show_committer.unwrap_or(self.show_committer),
            show_sha: saved.show_sha.unwrap_or(self.show_sha),
            show_pr: saved.show_pr.or(self.show_pr),
        }
    }

    /// What the layout file stores. A width the user never set stays out of the file.
    pub fn to_preferences(self) -> HistoryColumnPreferences {
        let width = |width: Option<i64>| width.and_then(|cells| u32::try_from(cells).ok());
        HistoryColumnPreferences {
            branch_width: width(self.branch_width),
            graph_width: width(self.graph_width),
            committer_width: width(self.committer_width),
            show_committer: Some(self.show_committer),
            show_sha: Some(self.show_sha),
            show_pr: self.show_pr,
        }
    }
}

/// Cells for `#N`, the checks icon, and a `+N` count.
pub const PR_COLUMN_WIDTH: i64 = 9;

/// The columns to draw. The PR column shows only when pull request data exists.
pub fn visible_history_columns(
    columns: HistoryColumns,
    pull_requests_available: bool,
) -> HistoryColumns {
    HistoryColumns {
        show_pr: Some(columns.show_pr.unwrap_or(true) && pull_requests_available),
        ..columns
    }
}

const MIN_MESSAGE_WIDTH: i64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryColumnLayout {
    pub branch_width: i64,
    pub graph_columns: usize,
    pub graph_width: i64,
    pub message_start: i64,
    pub message_width: i64,
    pub message_end: i64,
    pub committer_width: i64,
    pub pr_start: i64,
    pub pr_width: i64,
    pub sha_start: i64,
}

/// Shared geometry for painting and header drag hit testing.
pub fn history_column_layout(
    width: i64,
    lanes: usize,
    prefs: HistoryColumns,
) -> HistoryColumnLayout {
    let default_branch = 22.min(14.max((width as f64 * 0.28).floor() as i64));
    let branch_width = 4.max(
        prefs
            .branch_width
            .unwrap_or(default_branch)
            .min(4.max(width - 40)),
    );
    // The message column takes what the others leave, so no drag can leave
    // empty space beside the SHA column. Callers pass `visible_history_columns`,
    // so an unset PR flag means hidden here.
    let show_pr = prefs.show_pr == Some(true);
    let sha_width = if prefs.show_sha { 11 } else { 0 };
    let pr_width = if show_pr { PR_COLUMN_WIDTH } else { 0 };
    let pr_slot = if show_pr { pr_width + 3 } else { 0 };
    let committer_max =
        6.max(width - branch_width - 2 - 5 - 3 - MIN_MESSAGE_WIDTH - 3 - pr_slot - sha_width - 1);
    let committer_width = if prefs.show_committer {
        6.max(prefs.committer_width.unwrap_or(11).min(committer_max))
    } else {
        0
    };
    let metadata_width = (if prefs.show_committer {
        committer_width + 3
    } else {
        0
    }) + pr_slot
        + sha_width;
    let default_graph = 5.max(visible_graph_columns(lanes, width, branch_width) as i64 * 2);
    let graph_width = 5.max(
        prefs
            .graph_width
            .unwrap_or(default_graph)
            .min(5.max(width - branch_width - metadata_width - 2 - 3 - MIN_MESSAGE_WIDTH - 1)),
    );
    let graph_columns = (graph_width / 2).min(lanes as i64).max(1) as usize;
    let message_start = branch_width + 2 + graph_width + 3;
    let message_width = 1.max(width - message_start - metadata_width - 1);
    let message_end = message_start + message_width;
    let committer_slot = if prefs.show_committer {
        committer_width + 3
    } else {
        0
    };
    let pr_start = message_end + committer_slot + 3;
    let sha_start = message_end + committer_slot + pr_slot + if prefs.show_sha { 3 } else { 0 };
    HistoryColumnLayout {
        branch_width,
        graph_columns,
        graph_width,
        message_start,
        message_width,
        message_end,
        committer_width,
        pr_start,
        pr_width,
        sha_start,
    }
}

pub fn history_divider_at(column: i64, layout: &HistoryColumnLayout) -> Option<HistoryDividerKey> {
    if column >= layout.branch_width && column < layout.branch_width + 2 {
        return Some(HistoryDividerKey::BranchWidth);
    }
    if column >= layout.message_start - 3 && column < layout.message_start {
        return Some(HistoryDividerKey::GraphWidth);
    }
    if layout.committer_width > 0 && column >= layout.message_end && column < layout.message_end + 3
    {
        return Some(HistoryDividerKey::CommitterWidth);
    }
    None
}

/// Whether a press on a header separator completes a double click on it.
pub fn is_divider_double_click(
    previous: Option<(HistoryDividerKey, i64)>,
    key: HistoryDividerKey,
    now: i64,
    window_ms: i64,
) -> bool {
    previous.is_some_and(|(prev_key, at)| prev_key == key && now - at < window_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::temp_dir;
    use crate::preferences::{LayoutPreferences, load_layout_preferences, save_layout_preferences};

    #[test]
    fn widths_and_flags_survive_a_save_and_load() {
        let dir = temp_dir("history-columns");
        let path = dir.join("layout.json");
        let columns = HistoryColumns {
            branch_width: Some(18),
            graph_width: None,
            committer_width: Some(10),
            show_committer: false,
            show_sha: true,
            show_pr: Some(false),
        };
        let preferences = LayoutPreferences {
            history_columns: Some(columns.to_preferences()),
            ..LayoutPreferences::default()
        };
        save_layout_preferences(&preferences, &path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("graphWidth"),
            "an unset width stays out: {text}"
        );
        let saved = load_layout_preferences(&path).history_columns.unwrap();
        let defaults = HistoryColumns {
            show_committer: true,
            show_sha: true,
            ..HistoryColumns::default()
        };
        assert_eq!(defaults.with_saved(&saved), columns);
    }

    #[test]
    fn saved_values_replace_only_what_the_file_defines() {
        let current = HistoryColumns {
            branch_width: Some(20),
            committer_width: Some(9),
            show_committer: true,
            show_sha: true,
            ..HistoryColumns::default()
        };
        let saved = HistoryColumnPreferences {
            committer_width: Some(14),
            show_sha: Some(false),
            ..HistoryColumnPreferences::default()
        };
        assert_eq!(
            current.with_saved(&saved),
            HistoryColumns {
                committer_width: Some(14),
                show_sha: false,
                ..current
            }
        );
    }
}
