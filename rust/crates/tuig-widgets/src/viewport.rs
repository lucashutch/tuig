//! Vertical viewport of the history list. Ports the row arithmetic of `src/ui/runtime-history.ts` and the start
//! adjustment at the top of `paintHistory`.
//!
//! The list counts display rows. Row 0 is the working-changes row when the repository has changes, and every
//! commit takes one row after it. Line 0 of the widget is the header, so body line `n` shows row `start + n`.

/// Scroll position and selection. All fields are display rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Viewport {
    /// First row on screen.
    pub start: usize,
    pub selected: usize,
    /// True after a wheel scroll, so the viewport stays where the wheel left it and does not jump back to the
    /// selection. Selecting a row clears it.
    pub detached: bool,
}

impl Viewport {
    /// The start that painting uses: the selection pulled into view unless detached, then clamped to the rows.
    pub fn resolve(&mut self, total: usize, lines: usize) -> usize {
        let lines = lines.max(1);
        if !self.detached {
            if self.selected < self.start {
                self.start = self.selected;
            } else if self.selected >= self.start + lines {
                self.start = self.selected + 1 - lines;
            }
        }
        self.start = self.start.min(total.saturating_sub(lines));
        self.start
    }

    /// Moves the viewport by `delta` rows without moving the selection.
    pub fn wheel(&mut self, delta: i64, total: usize, lines: usize) {
        self.detached = true;
        let max = total.saturating_sub(lines.max(1)) as i64;
        self.start = (self.start as i64 + delta).clamp(0, max) as usize;
    }

    /// Selects a row and lets the viewport follow it again.
    pub fn select(&mut self, row: usize, total: usize) {
        self.detached = false;
        self.selected = row.min(total.saturating_sub(1));
    }

    /// The row under widget line `line`, where line 0 is the header.
    pub fn row_at_line(&self, line: i32, total: usize) -> Option<usize> {
        let body = usize::try_from(line.checked_sub(1)?).ok()?;
        let row = self.start + body;
        (row < total).then_some(row)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wheel_scrolls_the_viewport_and_keeps_the_selection() {
        let mut viewport = Viewport::default();
        viewport.select(2, 100);
        viewport.wheel(5, 100, 10);
        assert_eq!(viewport.resolve(100, 10), 5);
        assert_eq!(
            viewport.selected, 2,
            "the wheel does not move the selection"
        );
        // The selection is off screen, but a detached viewport does not jump back to it.
        viewport.wheel(200, 100, 10);
        assert_eq!(
            viewport.resolve(100, 10),
            90,
            "clamped to the last full page"
        );
        viewport.wheel(-500, 100, 10);
        assert_eq!(viewport.resolve(100, 10), 0);
    }

    #[test]
    fn selecting_a_row_brings_it_back_into_view() {
        let mut viewport = Viewport::default();
        viewport.wheel(40, 100, 10);
        viewport.select(3, 100);
        assert_eq!(viewport.resolve(100, 10), 3);
        viewport.select(30, 100);
        assert_eq!(
            viewport.resolve(100, 10),
            21,
            "the selection lands on the last line"
        );
    }

    #[test]
    fn click_lines_map_to_rows_below_the_header() {
        let mut viewport = Viewport::default();
        viewport.wheel(7, 50, 10);
        assert_eq!(viewport.row_at_line(0, 50), None, "the header is not a row");
        assert_eq!(viewport.row_at_line(1, 50), Some(7));
        assert_eq!(viewport.row_at_line(10, 50), Some(16));
        assert_eq!(viewport.row_at_line(-3, 50), None);
        viewport.wheel(100, 50, 10);
        assert_eq!(viewport.row_at_line(11, 50), None, "past the last row");
    }
}
