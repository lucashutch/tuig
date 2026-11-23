//! History header and scrollbar pointer input. Ports `src/ui/runtime-history-columns.ts` (divider drag, the columns
//! menu) and the scrollbar half of `src/ui/runtime-history.ts` (`pressHistoryScrollbar`, `dragHistoryScrollbar`,
//! `releaseHistoryScrollbar`). Hit testing happens in `HistoryList`. This file owns the drag state.

use crate::screens::popup::MenuRequest;
use crate::shell::{Dirty, Shell};
use opentui::prelude::*;
use std::time::Instant;
use tuig_ui_model::graph_menu::GraphMenuItem;
use tuig_ui_model::history_columns::{
    HistoryColumnLayout, HistoryDividerKey, drag_history_column, history_column_layout,
    history_divider_at, is_divider_double_click, visible_history_columns,
};
use tuig_ui_model::scrollbar::{ScrollbarGrab, scrollbar_drag, scrollbar_grab};
use tuig_widgets::history::{DOUBLE_CLICK, HistoryEvent};

/// A header separator drag: the separator, the pointer's terminal column and the column width when it began.
#[derive(Debug, Clone, Copy)]
struct DividerDrag {
    key: HistoryDividerKey,
    x: i64,
    width: i64,
}

/// Drag state of the history header and scrollbar.
pub struct HistoryPointerState {
    drag: Option<DividerDrag>,
    /// The last left press on a separator, in milliseconds since `clock`.
    last_divider_press: Option<(HistoryDividerKey, i64)>,
    clock: Instant,
    /// Where the scrollbar thumb is held, while a scrollbar drag runs.
    scrollbar: Option<ScrollbarGrab>,
}

impl Default for HistoryPointerState {
    fn default() -> Self {
        Self {
            drag: None,
            last_divider_press: None,
            clock: Instant::now(),
            scrollbar: None,
        }
    }
}

impl HistoryPointerState {
    /// The separator being dragged. The widget keeps it lit.
    pub fn dragging(&self) -> Option<HistoryDividerKey> {
        self.drag.map(|drag| drag.key)
    }
}

impl Shell {
    /// The geometry the widget paints with and hit tests against.
    pub(crate) fn history_geometry(&self) -> HistoryColumnLayout {
        history_column_layout(
            self.layout.panes.history_content_width,
            self.history.index.columns,
            visible_history_columns(self.history.columns, self.pr_column_available()),
        )
    }

    /// The header and scrollbar events of `HistoryList`.
    pub(crate) fn history_pointer(&mut self, app: &App, event: HistoryEvent) {
        match event {
            HistoryEvent::HeaderPress {
                button,
                column,
                x,
                y,
            } => {
                // A lost mouse-up must not leave a drag that captures later presses.
                let was_active =
                    self.history.pointer.scrollbar.is_some() || self.history.pointer.drag.is_some();
                self.release_history_scrollbar(app);
                self.history.pointer.drag = None;
                let changed = match button {
                    MouseButton::Right => {
                        self.open_columns_menu(i64::from(x), i64::from(y));
                        false
                    }
                    MouseButton::Left => self.press_divider(app, i64::from(column), i64::from(x)),
                    _ => false,
                };
                if changed || was_active {
                    self.dirty |= Dirty::HISTORY;
                }
            }
            HistoryEvent::ScrollbarPress { line } => {
                self.release_history_scrollbar(app);
                self.history.pointer.drag = None;
                self.press_history_scrollbar(app, i64::from(line));
            }
            HistoryEvent::Drag { x, line } => {
                if !self.drag_history_scrollbar(i64::from(line)) {
                    self.drag_divider(i64::from(x));
                }
            }
            HistoryEvent::Release => {
                let grabbed = self.history.pointer.scrollbar.is_some();
                self.release_history_scrollbar(app);
                let dragged = self.history.pointer.drag.take().is_some();
                if dragged {
                    self.persist_layout(app);
                }
                // The widget clears its own hover on release.
                if grabbed || dragged {
                    self.dirty |= Dirty::HISTORY;
                }
            }
            _ => {}
        }
    }

    /// A press on the header line with the right button: toggles Committer, SHA and, with pull request data, PR.
    fn open_columns_menu(&mut self, x: i64, y: i64) {
        let columns = self.history.columns;
        let mark =
            |shown: bool, name: &str| format!("{} {name}", if shown { "[x]" } else { "[ ]" });
        let committer = mark(columns.show_committer, "Committer");
        let sha = mark(columns.show_sha, "SHA");
        let pr = mark(columns.show_pr.unwrap_or(true), "PR");
        // The PR toggle appears only when there is pull request data to show.
        let labels = if self.pr_column_available() {
            vec![committer.clone(), pr.clone(), sha.clone()]
        } else {
            vec![committer.clone(), sha.clone()]
        };
        self.open_popup(MenuRequest {
            title: "History columns".to_owned(),
            items: labels.into_iter().map(GraphMenuItem::new).collect(),
            x,
            y,
            selected: None,
            on_select: Box::new(move |shell, app, item| {
                let columns = &mut shell.history.columns;
                if item.label == committer {
                    columns.show_committer = !columns.show_committer;
                } else if item.label == sha {
                    columns.show_sha = !columns.show_sha;
                } else if item.label == pr {
                    columns.show_pr = Some(!columns.show_pr.unwrap_or(true));
                }
                shell.persist_layout(app);
                shell.dirty |= Dirty::HISTORY;
            }),
        });
    }

    /// A left press on the header. A press on a separator starts a drag, and a second press on it within the
    /// double click time restores the column's default width.
    fn press_divider(&mut self, app: &App, column: i64, x: i64) -> bool {
        let layout = self.history_geometry();
        let Some(key) = history_divider_at(column, &layout) else {
            return false;
        };
        let pointer = &mut self.history.pointer;
        let now = i64::try_from(pointer.clock.elapsed().as_millis()).unwrap_or(i64::MAX);
        let window = i64::try_from(DOUBLE_CLICK.as_millis()).unwrap_or(i64::MAX);
        if is_divider_double_click(pointer.last_divider_press, key, now, window) {
            pointer.last_divider_press = None;
            self.history.columns = self.history.columns.reset_width(key);
            self.persist_layout(app);
        } else {
            pointer.last_divider_press = Some((key, now));
            pointer.drag = Some(DividerDrag {
                key,
                x,
                width: key.width_in(&layout),
            });
        }
        true
    }

    /// `dragTo`. The committer's left edge is its separator, so dragging right narrows it.
    fn drag_divider(&mut self, x: i64) {
        let Some(drag) = self.history.pointer.drag else {
            return;
        };
        let delta = if drag.key == HistoryDividerKey::CommitterWidth {
            drag.x - x
        } else {
            x - drag.x
        };
        self.history.columns = drag_history_column(
            self.history.columns,
            drag.key,
            drag.width,
            delta,
            self.layout.panes.history_content_width,
            self.history.index.columns,
            self.pr_column_available(),
        );
        self.dirty |= Dirty::HISTORY;
    }

    /// Rows the scrollbar covers, as painting counts them.
    fn history_scrollbar_rows(&self) -> (i64, i64) {
        (
            self.history_total() as i64,
            self.layout.history_lines().max(1) as i64,
        )
    }

    /// `pressHistoryScrollbar`: the widget found the press on the scrollbar column. `line` is the widget line, and
    /// the header takes line 0.
    fn press_history_scrollbar(&mut self, app: &App, line: i64) {
        if self.snapshot.is_none() {
            return;
        }
        let (total, viewport) = self.history_scrollbar_rows();
        let pointer = line - 1;
        if total <= viewport || !(0..viewport).contains(&pointer) {
            return;
        }
        if let Some(timer) = self.history.scroll_timer.take() {
            app.cancel_timer(timer);
        }
        self.history.pending_scroll = 0;
        self.history.pointer.scrollbar = Some(scrollbar_grab(
            total,
            self.history.viewport.start as i64,
            viewport,
            pointer,
        ));
        self.mark_history_scrolling(app);
        self.drag_history_scrollbar(line);
    }

    /// `dragHistoryScrollbar`. Returns whether a scrollbar drag is active.
    fn drag_history_scrollbar(&mut self, line: i64) -> bool {
        let Some(grab) = self.history.pointer.scrollbar else {
            return false;
        };
        let (total, viewport) = self.history_scrollbar_rows();
        let start = self.history.viewport.start;
        let (next, grab) = scrollbar_drag(&grab, total, start as i64, viewport, line - 1);
        self.history.pointer.scrollbar = Some(grab);
        self.history.viewport.detached = true;
        let next = usize::try_from(next).unwrap_or(0);
        if next != start {
            self.history.viewport.start = next;
            self.dirty |= Dirty::HISTORY;
        }
        true
    }

    /// `releaseHistoryScrollbar`. The settle delay then restores the avatars.
    pub(crate) fn release_history_scrollbar(&mut self, app: &App) {
        if self.history.pointer.scrollbar.take().is_some() {
            self.mark_history_scrolling(app);
        }
    }

    /// A press on a commit row ends any drag that lost its release.
    pub(crate) fn history_row_pressed(&mut self, app: &App) {
        self.release_history_scrollbar(app);
        self.history.pointer.drag = None;
    }
}

#[cfg(test)]
#[path = "history_columns_tests.rs"]
mod tests;
