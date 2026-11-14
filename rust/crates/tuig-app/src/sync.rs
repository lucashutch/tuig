//! Pushes shell state into widgets, once per drained inbox. Panes that are not ported yet are empty views placed
//! where `runtime-layout.ts` puts them, so the history pane has the same size and position as in the TS app.

use crate::shell::{Dirty, Inbox, Msg, PANE_TOP, Shell};
use opentui::prelude::*;
use opentui::widget::View;
use std::rc::Rc;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::theme::Theme;
use tuig_widgets::history::{HistoryEvent, HistoryList};

fn color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

pub struct Widgets {
    pub history: Custom<HistoryList>,
    /// Tab strip and toolbar rows.
    header: View,
    sidebar: View,
    details: View,
    /// Key hints on the bottom row.
    hints: View,
}

fn placeholder(app: &App, theme: &Theme) -> View {
    View::new(app).absolute().bg(color(theme.bg))
}

impl Widgets {
    pub fn new(app: &App, theme: &Theme, inbox: &Rc<Inbox>) -> Self {
        let mut list = HistoryList::new(theme.clone());
        list.set_focused(true);
        {
            let inbox = inbox.clone();
            list.on_event(move |cx, event| {
                let msg = match event {
                    HistoryEvent::Click {
                        row,
                        column,
                        clicks,
                    } => Msg::HistoryClick {
                        row,
                        column,
                        clicks,
                    },
                    HistoryEvent::Wheel(delta) => Msg::HistoryWheel(delta),
                    HistoryEvent::ScrollGraph(delta) => Msg::HistoryScrollGraph(delta),
                };
                inbox.post(cx.app(), msg);
            });
        }
        let history = Custom::new(app, list).absolute();
        let widgets = Self {
            history,
            header: placeholder(app, theme),
            sidebar: placeholder(app, theme),
            details: placeholder(app, theme),
            hints: placeholder(app, theme),
        };
        app.root()
            .bg(color(theme.bg))
            .add(&widgets.header)
            .add(&widgets.sidebar)
            .add(&widgets.history)
            .add(&widgets.details)
            .add(&widgets.hints);
        widgets.history.focus();
        widgets
    }
}

fn place(widget: &impl Widget, left: i64, top: i64, width: i64, height: i64) {
    let cells = |value: i64| u32::try_from(value.max(0)).unwrap_or(0);
    widget
        .position(Edge::Left, cells(left))
        .position(Edge::Top, cells(top))
        .width(cells(width))
        .height(cells(height));
}

impl Shell {
    pub fn sync(&mut self, _app: &App) {
        if self.dirty.contains(Dirty::LAYOUT) {
            let panes = self.layout.panes;
            let top = i64::from(PANE_TOP);
            let (width, height) = (i64::from(self.layout.width), i64::from(self.layout.height));
            let widgets = &self.widgets;
            place(&widgets.header, 0, 0, width, top);
            place(
                &widgets.sidebar,
                0,
                top,
                panes.sidebar_width,
                panes.divider_height,
            );
            place(
                &widgets.details,
                panes.details_left,
                top,
                panes.details_width,
                panes.divider_height,
            );
            place(&widgets.hints, 0, height - 1, width, 1);
            place(
                &widgets.history,
                panes.history_content_left,
                top,
                panes.history_content_width,
                panes.history_text_height,
            );
        }
        // `settle_history` can move the viewport start without a dirty flag, so compare with the widget's window.
        let stale = self.history.window.as_ref().is_none_or(|window| {
            window.start != self.history.viewport.start || window.total() != self.history_total()
        });
        if (self.dirty.contains(Dirty::HISTORY) || stale)
            && let Some(window) = self.history_window()
        {
            let window = Rc::new(window);
            self.history.window = Some(window.clone());
            let selected = Some(self.selected_row());
            let graph_scroll = self.history.graph_scroll;
            self.widgets.history.update(|list| {
                list.set_window(window);
                list.set_selected(selected);
                list.set_graph_scroll(graph_scroll);
            });
        }
        self.dirty = Dirty::empty();
    }
}
