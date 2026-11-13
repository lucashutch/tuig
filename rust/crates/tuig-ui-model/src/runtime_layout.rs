//! Pane sizing and placement math from `runtime-layout.ts`.
//!
//! The TypeScript functions write positions and sizes straight onto widgets. These functions
//! compute the same numbers from plain inputs and return them, so the UI layer applies them.
//! Text wrapping, button widths, and the change-section split come from other modules and enter
//! as inputs. All values are terminal cells.

/// Sidebar width limits shared by dragging and restoring a saved width.
pub fn clamp_sidebar_width(width: i64, terminal_width: i64) -> i64 {
    16.max(width.min(terminal_width - 45))
}

/// Details pane width limits shared by dragging and restoring a saved width.
pub fn clamp_details_width(width: i64, terminal_width: i64) -> i64 {
    30.max(width.min(terminal_width - 35))
}

/// The new sidebar width when the divider is dragged to column `x`.
pub fn sidebar_width_for_drag(x: i64, terminal_width: i64) -> i64 {
    clamp_sidebar_width(x, terminal_width)
}

/// The new details width when its divider is dragged to column `x`.
pub fn details_width_for_drag(x: i64, terminal_width: i64) -> i64 {
    clamp_details_width(terminal_width - x - 1, terminal_width)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneInputs {
    pub terminal_width: i64,
    pub left_width: i64,
    pub details_width: i64,
    pub left_collapsed: bool,
    pub details_collapsed: bool,
    /// Rows below the header and toolbar.
    pub content_height: i64,
    pub branch_filter_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaneLayout {
    pub total_width: i64,
    pub sidebar_width: i64,
    pub sidebar_visible: bool,
    pub branch_filter_left: i64,
    pub branch_filter_top_offset: i64,
    pub branch_filter_width: i64,
    pub branch_filter_visible: bool,
    /// Dividers stop above the bottom row so they cannot draw over the hints.
    pub divider_height: i64,
    pub left_divider_left: i64,
    pub left_divider_width: i64,
    pub left_divider_bar_left: i64,
    pub right_divider_left: i64,
    pub right_divider_bar_left: i64,
    pub history_left: i64,
    pub history_width: i64,
    pub history_content_left: i64,
    pub history_content_width: i64,
    pub history_text_height: i64,
    pub details_left: i64,
    pub details_width: i64,
    pub details_visible: bool,
}

/// Place the sidebar, history, and details panes and their dividers. A collapsed pane keeps only
/// its divider column. Tiny terminals keep every pane at least one cell wide.
pub fn layout_panes(input: PaneInputs) -> PaneLayout {
    let total = input.terminal_width.max(1);
    let available = (total - 2).max(3);
    let left_min = if input.left_collapsed {
        1
    } else {
        12.min(available)
    };
    let right_min = if input.details_collapsed {
        1
    } else {
        20.min(available)
    };
    let center_min = 1.max(18.min(available - left_min - right_min));
    let left = if input.left_collapsed {
        1
    } else {
        input
            .left_width
            .min(left_min.max(available - right_min - center_min))
    };
    let right = if input.details_collapsed {
        1
    } else {
        input
            .details_width
            .min(1.max(available - left - center_min))
    };
    let center = 1.max(available - left - right);
    let sidebar_width = left.min(total);
    let height = input.content_height;
    let divider_height = 1.max(height - 1);
    // A collapsed pane keeps only its divider column, so the graph starts immediately beside
    // whichever divider is showing.
    let left_boundary = if input.left_collapsed { 0 } else { left };
    let right_boundary = if input.details_collapsed {
        (left_boundary + 2).max(total - 1)
    } else {
        left + center + 1
    };
    let clamp_column = |x: i64| 0.max((total - 1).min(x));
    let history_left = (total - 1).min(left_boundary + 1);
    let history_width = 1.max((right_boundary - history_left).min(total - history_left));
    let details_left = total.min(right_boundary + 1);
    PaneLayout {
        total_width: total,
        sidebar_width,
        sidebar_visible: !input.left_collapsed && total > 1,
        branch_filter_left: 1,
        branch_filter_top_offset: 0,
        branch_filter_width: 8.max(sidebar_width - 2),
        branch_filter_visible: input.branch_filter_active && !input.left_collapsed,
        divider_height,
        // The sidebar's last column is its scrollbar, so the divider's hit box starts at the bar
        // instead of one cell to its left.
        left_divider_left: clamp_column(left_boundary),
        left_divider_width: if input.left_collapsed { 3 } else { 2 },
        left_divider_bar_left: clamp_column(left_boundary),
        right_divider_left: clamp_column(right_boundary - 1),
        right_divider_bar_left: clamp_column(right_boundary),
        history_left,
        history_width,
        history_content_left: history_left + 1,
        history_content_width: 1.max(history_width - 2),
        history_text_height: 1.max(height - 1),
        details_left,
        details_width: 1.max(right.min(1.max(total - details_left))),
        details_visible: !input.details_collapsed && details_left < total - 1,
    }
}

/// Divider glyphs, one row per line. The middle rows use the heavy grip glyph.
pub fn vertical_divider_content(divider_height: i64) -> String {
    let grip_height = 3.max(5.min(divider_height.div_euclid(3)));
    let grip_start = 0.max((divider_height - grip_height).div_euclid(2));
    (0..divider_height)
        .map(|row| {
            if row >= grip_start && row < grip_start + grip_height {
                "┃"
            } else {
                "│"
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The horizontal divider line for a pane `width` cells wide, with a heavy grip in the middle.
pub fn horizontal_divider_content(width: i64) -> String {
    let grip_width = 3.max(5.min(width.div_euclid(3)));
    let grip_start = 0.max((width - grip_width).div_euclid(2));
    let tail = 0.max(width - grip_start - grip_width);
    format!(
        "{}{}{}",
        "─".repeat(grip_start as usize),
        "━".repeat(grip_width as usize),
        "─".repeat(tail as usize)
    )
}

/// Constants for the fixed-size widgets in the commit card.
pub mod details {
    pub const COMMIT_HEADER_TOP: i64 = 1;
    pub const COMMIT_INFO_LEFT: i64 = 11;
    pub const COMMIT_INFO_TOP: i64 = 0;
    pub const AUTHOR_PHOTO: (i64, i64, i64, i64) = (1, 1, 8, 4);
    pub const AUTHOR_BADGE: (i64, i64, i64, i64) = (1, 1, 6, 3);
    pub const CO_AUTHOR_PROVIDER_LEFT: i64 = 1;
    pub const CO_AUTHOR_PROVIDER_WIDTH: i64 = 4;
    pub const CO_AUTHOR_PROVIDER_HEIGHT: i64 = 2;
}

/// The width to wrap the commit header, body, and co-author text to. It leaves room for the box
/// borders, text inset, scrollbar, and percentage width rounding used by OpenTUI's nested
/// renderables.
pub fn details_text_width(details_pane_width: i64) -> i64 {
    10.max(details_pane_width - 8)
}

/// The width to wrap the commit metadata text to.
pub fn details_info_width(details_pane_width: i64) -> i64 {
    10.max(details_pane_width - 13)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetailsInputs {
    pub details_pane_width: i64,
    /// Wrapped line counts, from the wrap widths above.
    pub header_lines: i64,
    pub body_lines: i64,
    pub info_lines: i64,
    /// `None` when the commit has no co-authors.
    pub co_authors_lines: Option<i64>,
    pub co_authors_provider_visible: bool,
    /// Rows of the working-changes banner above the message card.
    pub banner_rows: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetailsLayout {
    pub header_height: i64,
    pub body_top: i64,
    pub body_height: i64,
    pub message_box_top: i64,
    pub message_box_height: i64,
    pub edit_message_left: i64,
    pub info_height: i64,
    pub info_width: i64,
    pub info_box_top: i64,
    pub info_box_height: i64,
    pub co_authors_top: i64,
    pub co_authors_left: i64,
    pub co_authors_width: i64,
    pub label_width: i64,
    /// Where the changed-file section starts. It is not clamped into the metadata card, so a
    /// short terminal can push it off screen but never over the wrapped metadata rows.
    pub files_top: i64,
}

/// Place the commit message card, the metadata card, and the start of the file list. Inspection
/// follows a fixed order: message first, metadata, then files.
pub fn layout_details(input: DetailsInputs) -> DetailsLayout {
    let width = input.details_pane_width;
    let message_height = input.header_lines + 15.min(input.body_lines) + 3;
    let co_authors_top = 6.max(input.info_lines + 2);
    let co_authors_lines = input.co_authors_lines.unwrap_or(0);
    let info_height = 6
        .max(
            // A spare row below wrapped identities keeps the changed-file section off the final
            // metadata row.
            input.info_lines + 2,
        )
        .max(if input.co_authors_lines.is_some() {
            co_authors_top + co_authors_lines + 1
        } else {
            0
        });
    let co_authors_left = if input.co_authors_provider_visible {
        7
    } else {
        1
    };
    let info_box_top = input.banner_rows + message_height + 1;
    DetailsLayout {
        header_height: input.header_lines,
        body_top: input.header_lines,
        body_height: input.body_lines,
        message_box_top: input.banner_rows,
        message_box_height: message_height,
        edit_message_left: 1.max(width - 18),
        info_height: 1.max(info_height - 1),
        info_width: details_info_width(width),
        info_box_top,
        info_box_height: info_height,
        co_authors_top,
        co_authors_left,
        co_authors_width: 10.max(width - co_authors_left - 2),
        label_width: 1.max(width - 2),
        files_top: info_box_top + info_height + 1,
    }
}

/// Spaces between the `DETAILS` label and the short SHA, given display widths in cells. Without
/// a SHA the gap is one space.
pub fn details_label_gap(label_width: i64, label_columns: i64, sha_columns: Option<i64>) -> i64 {
    match sha_columns {
        Some(sha) => 2.max(label_width - label_columns - sha),
        None => 1,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffOverlayLayout {
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub height: i64,
    /// The width to choose inline or side-by-side from. It can be below one.
    pub view_width: i64,
    pub empty_left: i64,
    pub empty_top: i64,
    pub empty_width: i64,
}

/// A selected file diff overlays the history pane. Commit metadata stays in the details pane, and
/// the diff uses the history pane's full width.
pub fn layout_diff_overlay(
    history_left: i64,
    history_width: i64,
    content_height: i64,
    pane_top: i64,
) -> DiffOverlayLayout {
    DiffOverlayLayout {
        left: history_left + 1,
        top: pane_top + 1,
        width: 1.max(history_width - 2),
        height: 1.max(content_height - 2),
        view_width: history_width - 2,
        empty_left: history_left + 3,
        empty_top: pane_top + 4,
        empty_width: 1.max(history_width - 6),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    History,
    Commit,
    Working,
}

/// The result of `layoutChangeSections`, the split of the changes pane into file sections and
/// the composer. Another module computes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChangeSectionLayout {
    pub unstaged_top: i64,
    pub unstaged_height: i64,
    pub staged_top: i64,
    pub staged_height: i64,
    pub composer_top: i64,
    pub composer_height: i64,
    pub unstaged_divider_top: i64,
    pub composer_divider_top: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChangesInputs {
    pub view: View,
    pub editing_commit: bool,
    pub diff_visible: bool,
    pub history_filter_active: bool,
    /// `max(1, details pane width)`.
    pub width: i64,
    pub content_height: i64,
    pub snapshot_file_count: usize,
    pub commit_files_top: i64,
    /// Rows the unstaged list can show.
    pub unstaged_viewport: i64,
    pub discard_button_width: i64,
    pub stage_all_button_width: i64,
    pub unstage_all_button_width: i64,
    pub staged_collapsed: bool,
    pub staged_file_count: usize,
    pub sections: ChangeSectionLayout,
}

/// Widget visibility. `None` leaves the widget as it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChangesVisibility {
    pub discard_button: Option<bool>,
    pub stage_all_button: Option<bool>,
    pub unstage_all_button: Option<bool>,
    pub composer_box: Option<bool>,
    pub staged_label: Option<bool>,
    pub staged_text: Option<bool>,
    pub unstaged_label: Option<bool>,
    pub unstaged_text: Option<bool>,
    pub amend_button: Option<bool>,
    pub working_banner: Option<bool>,
    pub edit_message_button: Option<bool>,
    pub unstaged_divider: Option<bool>,
    pub composer_divider: Option<bool>,
    pub unstaged_divider_bar: Option<bool>,
    pub composer_divider_bar: Option<bool>,
}

/// While a file's history is open over a commit diff, the details pane gets a fixed share of the
/// height. Navigation must stay under the pointer while selections change, so the split does not
/// follow each commit's wrapped message and metadata height.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileHistorySplit {
    pub message_box_top: i64,
    pub message_box_height: i64,
    pub info_box_top: i64,
    pub info_box_height: i64,
    pub unstaged_label_top: i64,
    pub unstaged_text_top: i64,
    pub unstaged_text_height: i64,
}

pub fn file_history_split(height: i64) -> FileHistorySplit {
    let history_top = 8.max(1.max(height - 6).min((height as f64 * 0.58).floor() as i64));
    let message_height = 4.max((history_top as f64 * 0.45).floor() as i64);
    FileHistorySplit {
        message_box_top: 0,
        message_box_height: message_height,
        info_box_top: message_height + 1,
        info_box_height: 4.max(history_top - message_height - 2),
        unstaged_label_top: history_top,
        unstaged_text_top: history_top + 1,
        unstaged_text_height: 1.max(height - history_top - 2),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComposerLayout {
    pub top: i64,
    pub height: i64,
    pub visible: bool,
    pub box_width: i64,
    /// Width of the summary, body, and commit button inside the box.
    pub field_width: i64,
    pub children: ComposerChildren,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComposerChildren {
    pub body_top: i64,
    pub body_height: i64,
    pub summary_visible: bool,
    pub body_visible: bool,
    pub amend_visible: bool,
    pub commit_visible: bool,
    pub amend_top: i64,
    pub commit_top: i64,
}

pub fn layout_composer_children(height: i64, width: i64, editing_commit: bool) -> ComposerChildren {
    let has_field_room = width >= 2;
    let show_actions = has_field_room && height >= 6;
    ComposerChildren {
        body_top: 2,
        body_height: 1.max(height - 6),
        summary_visible: has_field_room && height >= 2,
        body_visible: has_field_room && height >= 3,
        amend_visible: show_actions && !editing_commit,
        commit_visible: show_actions,
        amend_top: height - 3,
        commit_top: height - 2,
    }
}

fn composer(top: i64, height: i64, width: i64, editing_commit: bool) -> ComposerLayout {
    // Percentage widths round unpredictably inside nested renderables, so the composer's
    // children are sized from the pane width directly.
    let box_width = 1.max(width - 2);
    ComposerLayout {
        top,
        height,
        visible: height > 0 && width >= 2,
        box_width,
        field_width: 1.max(box_width - 1),
        children: layout_composer_children(height, box_width, editing_commit),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DividerPlacement {
    pub top: i64,
    pub left: i64,
    pub width: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkingChangesGeometry {
    pub discard_left: i64,
    pub stage_all_left: i64,
    pub unstaged_label_top: i64,
    pub unstaged_text_top: i64,
    pub unstaged_text_height: i64,
    pub staged_label_top: i64,
    pub unstage_all_top: i64,
    pub unstage_all_left: i64,
    pub staged_text_top: i64,
    pub staged_text_height: i64,
    pub composer: ComposerLayout,
    pub unstaged_divider: DividerPlacement,
    pub composer_divider: DividerPlacement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangesGeometry {
    /// A commit diff is open. Only the file-history split moves anything.
    CommitDiff {
        file_history: Option<FileHistorySplit>,
    },
    /// The commit's changed-file list.
    CommitFiles {
        unstaged_label_top: i64,
        unstaged_text_top: i64,
        unstaged_text_height: i64,
    },
    /// Editing a commit message in the composer.
    Editing(ComposerLayout),
    /// The working-tree pane.
    Working(WorkingChangesGeometry),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChangesLayout {
    pub visibility: ChangesVisibility,
    pub unstage_all_visible: Option<bool>,
    pub unstaged_text_visible: Option<bool>,
    pub staged_text_visible: Option<bool>,
    pub geometry: ChangesGeometry,
}

/// Place the changes pane: pane actions, the two file sections, and the commit composer, or the
/// commit-file list when a commit is open.
pub fn layout_changes(input: ChangesInputs) -> ChangesLayout {
    let commit_view = input.view == View::Commit;
    let editing = input.editing_commit;
    let width = input.width;
    let height = input.content_height;
    let mut vis = ChangesVisibility::default();
    // Diffs overlay the history pane. Keep the working changes layout intact; commit diffs
    // retain their file picker without the working-tree controls.
    if input.diff_visible && commit_view {
        vis.discard_button = Some(false);
        vis.stage_all_button = Some(false);
        vis.unstage_all_button = Some(false);
        vis.staged_label = Some(false);
        vis.staged_text = Some(false);
        vis.unstaged_divider = Some(false);
        vis.composer_divider = Some(false);
        vis.unstaged_divider_bar = Some(false);
        vis.composer_divider_bar = Some(false);
        vis.composer_box = Some(false);
        vis.unstaged_label = Some(true);
        vis.unstaged_text = Some(true);
        if input.history_filter_active {
            vis.working_banner = Some(false);
            vis.edit_message_button = Some(false);
        }
        vis.amend_button = Some(false);
        return ChangesLayout {
            visibility: vis,
            unstage_all_visible: None,
            unstaged_text_visible: None,
            staged_text_visible: None,
            geometry: ChangesGeometry::CommitDiff {
                file_history: input
                    .history_filter_active
                    .then(|| file_history_split(height)),
            },
        };
    }
    let working_actions = !commit_view;
    vis.discard_button = Some(working_actions);
    vis.stage_all_button = Some(working_actions);
    vis.unstage_all_button = Some(working_actions);
    vis.staged_label = Some(working_actions);
    vis.staged_text = Some(working_actions);
    vis.composer_box = Some(working_actions || editing);
    vis.amend_button = Some(!commit_view);
    vis.working_banner = Some(commit_view && !editing && input.snapshot_file_count > 0);
    vis.edit_message_button = Some(commit_view && !editing);
    let dividers = !commit_view && !editing;
    vis.unstaged_divider = Some(dividers);
    vis.composer_divider = Some(dividers);
    vis.unstaged_divider_bar = Some(dividers);
    vis.composer_divider_bar = Some(dividers);
    let mut layout = ChangesLayout {
        visibility: vis,
        unstage_all_visible: None,
        unstaged_text_visible: None,
        staged_text_visible: None,
        geometry: ChangesGeometry::CommitFiles {
            unstaged_label_top: 0,
            unstaged_text_top: 0,
            unstaged_text_height: 0,
        },
    };
    if commit_view && !editing {
        // These widgets also show the commit file list. Restore them explicitly because a
        // preceding working-tree diff hides them.
        layout.visibility.unstaged_label = Some(true);
        layout.visibility.unstaged_text = Some(true);
        layout.geometry = ChangesGeometry::CommitFiles {
            unstaged_label_top: input.commit_files_top,
            unstaged_text_top: input.commit_files_top + 1,
            unstaged_text_height: input.unstaged_viewport,
        };
        return layout;
    }
    if editing {
        let composer_height = 0.max(height - 2);
        layout.visibility.composer_box = Some(composer_height > 0 && width >= 2);
        layout.geometry = ChangesGeometry::Editing(composer(1, composer_height, width, true));
        return layout;
    }
    let s = input.sections;
    let composer_layout = composer(s.composer_top, s.composer_height, width, false);
    layout.visibility.composer_box = Some(composer_layout.visible);
    layout.visibility.unstaged_divider = Some(true);
    layout.visibility.composer_divider = Some(true);
    layout.visibility.unstaged_divider_bar = Some(true);
    layout.visibility.composer_divider_bar = Some(true);
    layout.unstaged_text_visible = Some(s.unstaged_height > 0);
    layout.staged_text_visible = Some(s.staged_height > 0);
    layout.unstage_all_visible = Some(!input.staged_collapsed && input.staged_file_count > 0);
    let divider = |top: i64| DividerPlacement {
        top: 0.max(top - 1),
        left: width.div_euclid(4),
        width: width.min(5.max(width.div_euclid(2))),
    };
    layout.geometry = ChangesGeometry::Working(WorkingChangesGeometry {
        discard_left: 1,
        stage_all_left: (input.discard_button_width + 2)
            .max(width - input.stage_all_button_width - 2),
        unstaged_label_top: s.unstaged_top,
        unstaged_text_top: s.unstaged_top + 1,
        unstaged_text_height: 1.max(s.unstaged_height),
        staged_label_top: s.staged_top,
        unstage_all_top: s.staged_top,
        unstage_all_left: 1.max(width - input.unstage_all_button_width - 2),
        staged_text_top: s.staged_top + 1,
        staged_text_height: 1.max(s.staged_height),
        composer: composer_layout,
        unstaged_divider: divider(s.unstaged_divider_top),
        composer_divider: divider(s.composer_divider_top),
    });
    layout
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panes(terminal_width: i64) -> PaneInputs {
        PaneInputs {
            terminal_width,
            left_width: 30,
            details_width: 40,
            left_collapsed: false,
            details_collapsed: false,
            content_height: 30,
            branch_filter_active: false,
        }
    }

    #[test]
    fn clamps_widths_saved_on_a_wide_terminal_to_a_narrow_one() {
        assert_eq!(clamp_sidebar_width(90, 100), 55);
        assert_eq!(clamp_sidebar_width(90, 200), 90);
        assert_eq!(clamp_sidebar_width(2, 100), 16);
        assert_eq!(clamp_details_width(120, 100), 65);
        assert_eq!(clamp_details_width(5, 100), 30);
        assert_eq!(details_width_for_drag(60, 100), 39);
    }

    #[test]
    fn a_roomy_terminal_fits_three_panes_edge_to_edge() {
        let layout = layout_panes(panes(120));
        assert_eq!(layout.sidebar_width, 30);
        assert_eq!(layout.history_left, 31);
        assert_eq!(layout.details_width, 40);
        // Sidebar, divider, history, divider, and details fill the width.
        assert_eq!(layout.details_left + layout.details_width, 120);
        assert!(layout.details_visible && layout.sidebar_visible);
    }

    #[test]
    fn tiny_terminals_never_produce_zero_or_negative_widths() {
        for width in -2..60 {
            for (left_collapsed, details_collapsed) in
                [(false, false), (true, false), (false, true), (true, true)]
            {
                let layout = layout_panes(PaneInputs {
                    left_collapsed,
                    details_collapsed,
                    content_height: 0,
                    ..panes(width)
                });
                let ctx = format!(
                    "width {width} collapsed {left_collapsed}/{details_collapsed}: {layout:?}"
                );
                assert!(
                    layout.history_width >= 1 && layout.history_content_width >= 1,
                    "{ctx}"
                );
                assert!(
                    layout.details_width >= 1 && layout.sidebar_width >= 1,
                    "{ctx}"
                );
                assert!(
                    layout.divider_height >= 1 && layout.history_text_height >= 1,
                    "{ctx}"
                );
                for column in [
                    layout.left_divider_left,
                    layout.right_divider_left,
                    layout.right_divider_bar_left,
                ] {
                    assert!((0..layout.total_width).contains(&column), "{ctx}");
                }
            }
        }
    }

    #[test]
    fn a_collapsed_sidebar_leaves_its_divider_and_gives_the_graph_the_room() {
        let open = layout_panes(panes(120));
        let collapsed = layout_panes(PaneInputs {
            left_collapsed: true,
            ..panes(120)
        });
        assert!(!collapsed.sidebar_visible);
        assert_eq!(collapsed.left_divider_left, 0);
        assert_eq!(collapsed.left_divider_width, 3);
        assert_eq!(collapsed.history_left, 1);
        assert!(collapsed.history_width > open.history_width);
    }

    #[test]
    fn a_narrow_terminal_shrinks_the_sidebar_and_details_to_keep_the_graph() {
        let layout = layout_panes(PaneInputs {
            left_width: 50,
            details_width: 60,
            ..panes(80)
        });
        assert!(layout.history_width >= 18, "{layout:?}");
        assert!(layout.sidebar_width < 50);
        assert!(layout.details_width < 60);
    }

    #[test]
    fn divider_grips_sit_in_the_middle() {
        // A one-row divider is all grip, as in the TypeScript layout.
        assert_eq!(vertical_divider_content(1), "┃");
        let rows = vertical_divider_content(12);
        let heavy: Vec<usize> = rows
            .split('\n')
            .enumerate()
            .filter(|(_, r)| *r == "┃")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(heavy, [4, 5, 6, 7]);
        let line = horizontal_divider_content(30);
        assert_eq!(line.chars().count(), 30);
        assert_eq!(line.chars().filter(|c| *c == '━').count(), 5);
        assert_eq!(
            line,
            format!("{}{}{}", "─".repeat(12), "━".repeat(5), "─".repeat(13))
        );
    }

    #[test]
    fn commit_cards_stack_without_overlap_when_text_wraps() {
        let layout = layout_details(DetailsInputs {
            details_pane_width: 40,
            header_lines: 2,
            body_lines: 30,
            info_lines: 4,
            co_authors_lines: Some(3),
            co_authors_provider_visible: true,
            banner_rows: 3,
        });
        // The body text box stops at 15 lines, and the metadata card starts one row below the
        // message card.
        assert_eq!(layout.message_box_height, 2 + 15 + 3);
        assert_eq!(layout.info_box_top, 3 + layout.message_box_height + 1);
        // The co-author block fits inside the metadata card, and files start below it.
        assert!(layout.co_authors_top + 3 < layout.info_box_height);
        assert_eq!(
            layout.files_top,
            layout.info_box_top + layout.info_box_height + 1
        );
        assert_eq!(layout.co_authors_left, 7);
        assert_eq!(details_label_gap(38, 7, Some(7)), 24);
        assert_eq!(details_label_gap(10, 7, Some(7)), 2);
        assert_eq!(details_label_gap(10, 7, None), 1);
    }

    fn changes(view: View, diff_visible: bool) -> ChangesInputs {
        ChangesInputs {
            view,
            editing_commit: false,
            diff_visible,
            history_filter_active: false,
            width: 40,
            content_height: 24,
            snapshot_file_count: 1,
            commit_files_top: 4,
            unstaged_viewport: 10,
            discard_button_width: 9,
            stage_all_button_width: 11,
            unstage_all_button_width: 13,
            staged_collapsed: false,
            staged_file_count: 1,
            sections: ChangeSectionLayout {
                unstaged_top: 2,
                unstaged_height: 6,
                staged_top: 9,
                staged_height: 4,
                composer_top: 14,
                composer_height: 8,
                unstaged_divider_top: 8,
                composer_divider_top: 13,
            },
        }
    }

    #[test]
    fn commit_diffs_keep_the_commit_file_list_visible() {
        let layout = layout_changes(changes(View::Commit, true));
        assert_eq!(layout.visibility.unstaged_label, Some(true));
        assert_eq!(layout.visibility.unstaged_text, Some(true));
        assert_eq!(layout.visibility.staged_text, Some(false));
        assert_eq!(layout.visibility.composer_box, Some(false));
    }

    #[test]
    fn working_tree_diffs_retain_both_file_sections_and_the_composer() {
        let layout = layout_changes(changes(View::Working, true));
        assert_eq!(layout.visibility.staged_label, Some(true));
        assert_eq!(layout.visibility.working_banner, Some(false));
        assert_eq!(layout.visibility.edit_message_button, Some(false));
        assert_eq!(layout.visibility.composer_box, Some(true));
        assert_eq!(layout.staged_text_visible, Some(true));
        let ChangesGeometry::Working(geometry) = layout.geometry else {
            panic!("working geometry")
        };
        assert_eq!(geometry.stage_all_left, 40 - 11 - 2);
        assert_eq!(geometry.composer.field_width, 37);
        assert_eq!(geometry.composer_divider.top, 12);
    }

    #[test]
    fn the_composer_hides_fields_that_do_not_fit() {
        let tiny = layout_composer_children(2, 10, false);
        assert!(tiny.summary_visible && !tiny.body_visible && !tiny.commit_visible);
        let narrow = layout_composer_children(10, 1, false);
        assert!(!narrow.summary_visible && !narrow.commit_visible);
        let full = layout_composer_children(8, 10, true);
        assert!(full.commit_visible && !full.amend_visible);
        assert_eq!((full.amend_top, full.commit_top), (5, 6));
    }
}
