//! Where the pointer is, for widgets that highlight what is under it.
//!
//! OpenTUI sends `Widget::on_hover(true)` to a widget when a frame moves it under a pointer that has not moved, for
//! example after a popup closes. That call carries no position. Widgets that highlight a part of themselves, such as a
//! toolbar button or a history row, record every pointer event they and the popup layer see in a shared
//! [`PointerTracker`], and read the position back when the pointer enters.

use opentui::prelude::*;
use std::cell::Cell;
use std::rc::Rc;

/// The terminal cell of the last pointer event that a tracking widget saw. Clones share one position.
#[derive(Debug, Clone, Default)]
pub struct PointerTracker(Rc<Cell<Option<(u16, u16)>>>);

impl PointerTracker {
    pub fn record(&self, event: &MouseEvent) {
        self.0.set(Some((event.x, event.y)));
    }

    pub fn get(&self) -> Option<(u16, u16)> {
        self.0.get()
    }

    /// The tracked position in a widget's own cells, given where the widget's top left cell was on the terminal.
    /// `None` before any event, or for a position left of or above the widget.
    pub fn local(&self, origin: Option<(i32, i32)>) -> Option<(i32, i32)> {
        let (x, y) = self.get()?;
        let (left, top) = origin?;
        let local = (i32::from(x) - left, i32::from(y) - top);
        (local.0 >= 0 && local.1 >= 0).then_some(local)
    }
}

/// A widget's top left cell on the terminal, from a pointer event that landed at `local` inside it.
pub fn origin_of(event: &MouseEvent, local: (i32, i32)) -> (i32, i32) {
    (i32::from(event.x) - local.0, i32::from(event.y) - local.1)
}
