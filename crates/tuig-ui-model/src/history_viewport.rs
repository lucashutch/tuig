//! History selection and vertical viewport. Ports the row arithmetic of `src/ui/runtime-history.ts` (`moveCommit`,
//! `scrollHistoryViewport`, `commitRowAtLine`) and the start adjustment at the top of `paintHistory` in
//! `src/ui/runtime-paint.ts`.
//!
//! The list counts display rows. Row 0 is the working-changes row when the repository has changes, and every
//! commit takes one row after it. Line 0 of the history pane is the column header, so body line `n` shows row
//! `start + n`.

/// Rows one wheel notch scrolls. `WHEEL_ROWS` in `src/ui/runtime-widgets.ts`.
pub const WHEEL_ROWS: i32 = 1;

/// Distance from the last loaded row at which the next page is read. `HISTORY_PREFETCH_ROWS` in
/// `src/ui/runtime-data.ts`.
pub const HISTORY_PREFETCH_ROWS: usize = 50;

/// Body lines of the history pane for a content height (terminal rows below the toolbar). `visibleUnits` in
/// `src/ui/runtime-paint.ts`: the pane loses one line to the header and one to the hints row.
pub fn history_lines(content_height: i64) -> usize {
    (content_height - 2).max(1) as usize
}

/// The viewport start that puts a commit near the middle of the pane. Ports `historyStartForCommit` in
/// `src/ui/runtime-history.ts`. `lines` is the body line count, which TS derives as `contentHeight - 2`.
pub fn history_start_for_commit(
    commit_index: usize,
    has_working: bool,
    lines: usize,
    total_commits: usize,
) -> usize {
    let lines = lines.max(1);
    let leading = usize::from(has_working);
    let selected_row = commit_index + leading;
    let total_rows = total_commits + leading;
    let centered = selected_row.saturating_sub(lines / 2);
    centered.min(total_rows.saturating_sub(lines))
}

/// The selected row, kept apart from display rows so that the working row appearing or disappearing does not move
/// the selection to another commit. TypeScript keeps `historySelection` and `commitIndex` the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HistorySelection {
    #[default]
    Working,
    Commit(usize),
}

impl HistorySelection {
    /// The display row. A working selection without a working row shows commit 0, as `paintHistory` does.
    pub fn row(self, has_working: bool) -> usize {
        match self {
            Self::Working => 0,
            Self::Commit(index) => index + usize::from(has_working),
        }
    }

    pub fn commit(self) -> Option<usize> {
        match self {
            Self::Working => None,
            Self::Commit(index) => Some(index),
        }
    }

    /// The selection for a display row.
    pub fn from_row(row: usize, has_working: bool) -> Self {
        match (has_working, row) {
            (true, 0) => Self::Working,
            (true, row) => Self::Commit(row - 1),
            (false, row) => Self::Commit(row),
        }
    }

    /// Moves by `delta` rows with the keyboard. Ports `moveCommit`: from the working row only a downward move
    /// goes anywhere, and moving up from the first commit returns to the working row.
    pub fn moved(self, delta: i64, has_working: bool, commits: usize) -> Self {
        match self {
            Self::Working if delta <= 0 => self,
            Self::Working => Self::Commit(0),
            Self::Commit(0) if has_working && delta < 0 => Self::Working,
            Self::Commit(index) => {
                let last = commits.saturating_sub(1) as i64;
                Self::Commit((index as i64 + delta).clamp(0, last) as usize)
            }
        }
    }
}

/// Scroll position of the history list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HistoryViewport {
    /// First display row on screen.
    pub start: usize,
    /// True after a wheel scroll, so the viewport stays where the wheel left it and does not jump back to the
    /// selection. A keyboard move or a click clears it. `historyViewportDetached` in TypeScript.
    pub detached: bool,
}

impl HistoryViewport {
    /// The start that painting uses: the selection pulled into view unless detached, then clamped to the rows.
    pub fn resolve(&mut self, selected_row: usize, total: usize, lines: usize) -> usize {
        let lines = lines.max(1);
        if !self.detached {
            if selected_row < self.start {
                self.start = selected_row;
            } else if selected_row >= self.start + lines {
                self.start = selected_row + 1 - lines;
            }
        }
        self.start = self.start.min(total.saturating_sub(lines));
        self.start
    }

    /// Moves the viewport by `delta` rows without moving the selection. Ports `scrollHistoryViewport`, including
    /// its limit: while the working row is on screen it counts as reserved, so the limit is one row higher than
    /// the one [`resolve`](Self::resolve) applies at the next paint.
    pub fn scroll(&mut self, delta: i64, total: usize, lines: usize, has_working: bool) {
        let reserved = usize::from(has_working && self.start == 0);
        let visible = lines.saturating_sub(reserved).max(1);
        let max = total.saturating_sub(visible) as i64;
        self.detached = true;
        self.start = (self.start as i64 + delta).clamp(0, max) as usize;
    }

    /// The display row under pane line `line`, where line 0 is the header.
    pub fn row_at_line(&self, line: i32, total: usize) -> Option<usize> {
        let body = usize::try_from(line.checked_sub(1)?).ok()?;
        let row = self.start + body;
        (row < total).then_some(row)
    }

    /// Whether the next page should load: fewer than [`HISTORY_PREFETCH_ROWS`] rows remain below the viewport.
    pub fn wants_more(&self, total: usize, lines: usize) -> bool {
        total.saturating_sub(self.start + lines) <= HISTORY_PREFETCH_ROWS
    }
}
