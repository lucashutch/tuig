//! Geometry of the changed-files pane that `runtime_layout` leaves to the caller. Ports
//! `layoutChangeSections` (`src/ui/runtime-presentation-changes.ts`), `fileViewportSize`
//! (`runtime-presentation-text.ts`) and `fileColor`.

use crate::color::Rgba;
use crate::runtime_layout::{ChangeSectionLayout, View};
use crate::theme::Theme;
use tuig_git::types::FileState;

/// Rows of the commit composer at the foot of the changes pane. `COMMIT_COMPOSER_HEIGHT`.
pub const COMMIT_COMPOSER_HEIGHT: i64 = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ChangeSectionsInput {
    /// Rows the pane can use, without the bottom hints row.
    pub available: i64,
    pub unstaged_collapsed: bool,
    pub staged_collapsed: bool,
    /// Height chosen by dragging the staged-section divider.
    pub preferred_unstaged_height: Option<i64>,
    /// Height chosen by dragging the composer divider.
    pub preferred_composer_height: Option<i64>,
}

/// Splits the changes pane between the unstaged list, the staged list and the composer. By default the
/// divider sits in the middle. A dragged height survives repaints and resizes.
pub fn layout_change_sections(input: ChangeSectionsInput) -> ChangeSectionLayout {
    // Row 0 holds the actions. Both headings and both dividers are structural rows.
    let open = i64::from(!input.unstaged_collapsed) + i64::from(!input.staged_collapsed);
    let fixed_rows = 5;
    let composer_maximum = (input.available - fixed_rows - open).max(0);
    let composer_height = composer_maximum.min(
        input
            .preferred_composer_height
            .unwrap_or(COMMIT_COMPOSER_HEIGHT)
            .max(0),
    );
    let room = (input.available - fixed_rows - composer_height).max(0);
    let (mut unstaged_height, mut staged_height) = (0, 0);
    if open == 1 {
        if input.unstaged_collapsed {
            staged_height = room;
        } else {
            unstaged_height = room;
        }
    } else if open == 2 {
        if room < 2 {
            unstaged_height = room;
        } else {
            let preferred = input.preferred_unstaged_height.unwrap_or(room / 2);
            unstaged_height = (room - 1).min(preferred).max(1);
        }
        staged_height = room - unstaged_height;
    }
    let unstaged_top = 1;
    let unstaged_divider_top = unstaged_top + 1 + unstaged_height;
    let staged_top = unstaged_divider_top + 1;
    let composer_divider_top = staged_top + 1 + staged_height;
    ChangeSectionLayout {
        unstaged_top,
        unstaged_height,
        staged_top,
        staged_height,
        composer_top: composer_divider_top + 1,
        composer_height,
        unstaged_divider_top,
        composer_divider_top,
    }
}

/// Rows a file list shows in the commit view, label row included, and the cap in the working view.
pub fn file_viewport_size(view: View, terminal_height: i64, commit_files_top: i64) -> i64 {
    if view == View::Commit {
        (terminal_height - commit_files_top - 2).max(1)
    } else {
        (terminal_height - 3).clamp(1, 7)
    }
}

/// The status color of a tree row. `None` keeps the icon color. Directories without a status use the folder color.
pub fn file_color(state: Option<FileState>, directory: bool, theme: &Theme) -> Option<Rgba> {
    let Some(state) = state else {
        return directory.then_some(theme.folder);
    };
    Some(match state {
        FileState::Deleted | FileState::Conflicted => theme.deleted,
        FileState::Added | FileState::Untracked => theme.added,
        FileState::Renamed | FileState::Copied => theme.accent,
        FileState::Modified => theme.warning,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sections(available: i64, unstaged_collapsed: bool) -> ChangeSectionLayout {
        layout_change_sections(ChangeSectionsInput {
            available,
            unstaged_collapsed,
            ..ChangeSectionsInput::default()
        })
    }

    #[test]
    fn splits_the_demo_pane_like_the_ts_app() {
        // 160x48 terminal: 45 content rows, 44 available. The dividers sit one row above these tops, which are the
        // rows the parity golden draws them on.
        let layout = sections(44, false);
        assert_eq!(
            (
                layout.unstaged_height,
                layout.staged_height,
                layout.composer_height
            ),
            (13, 14, 12)
        );
        assert_eq!(layout.unstaged_divider_top, 15);
        assert_eq!(layout.staged_top, 16);
        assert_eq!(layout.composer_divider_top, 31);
    }

    #[test]
    fn a_collapsed_section_gives_its_room_to_the_other() {
        let layout = sections(44, true);
        assert_eq!(layout.unstaged_height, 0);
        assert_eq!(layout.staged_height, 27);
    }
}
