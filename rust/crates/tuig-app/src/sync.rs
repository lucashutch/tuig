//! Pushes shell state into widgets, once per drained inbox. Panes that are not ported yet are empty views placed
//! where `runtime-layout.ts` puts them, so the history pane has the same size and position as in the TS app.

use crate::screens::composer::ComposerWidgets;
use crate::screens::details::DetailsView;
use crate::screens::files::FilesWidgets;
use crate::screens::header::HeaderWidgets;
use crate::screens::popup::{OverlayMsg, OverlayWidgets};
use crate::screens::sidebar::SidebarWidgets;
use crate::shell::{Dirty, Inbox, Msg, PANE_TOP, Shell};
use opentui::prelude::*;
use opentui::widget::View;
use std::rc::Rc;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::theme::Theme;
use tuig_widgets::diff::DiffPane;
use tuig_widgets::footer::Footer;
use tuig_widgets::history::{HistoryEvent, HistoryList};

fn color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

pub struct Widgets {
    /// The screen background. `renderer.setBackgroundColor` in TS. The root view does not fill its background, so a
    /// full-size view behind every pane does.
    backdrop: View,
    pub history: Custom<HistoryList>,
    pub diff: Custom<DiffPane>,
    /// Tab strip and toolbar rows.
    pub header: HeaderWidgets,
    pub sidebar: SidebarWidgets,
    details: View,
    pub files: FilesWidgets,
    pub composer: ComposerWidgets,
    pub details_view: DetailsView,
    /// Key hints and the message on the bottom row.
    pub footer: Custom<Footer>,
    /// Menus, the palette and the prompts, above everything else.
    pub overlay: OverlayWidgets,
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
                    HistoryEvent::Menu {
                        row,
                        on_label,
                        x,
                        y,
                    } => Msg::Overlay(OverlayMsg::HistoryMenu {
                        row,
                        on_label,
                        x,
                        y,
                    }),
                };
                inbox.post(cx.app(), msg);
            });
        }
        let history = Custom::new(app, list).absolute();
        let details = placeholder(app, theme).bg(color(theme.panel));
        let files = FilesWidgets::new(app, theme, inbox);
        files.attach(&details);
        let composer = ComposerWidgets::new(app, theme, inbox);
        composer.attach(&details);
        let details_view = DetailsView::new(app, theme, inbox);
        details_view.attach(&details);
        let widgets = Self {
            backdrop: placeholder(app, theme),
            history,
            diff: crate::screens::diff::diff_widget(app, theme, inbox),
            header: HeaderWidgets::new(app, theme, inbox),
            sidebar: SidebarWidgets::new(app, theme, inbox),
            details,
            files,
            composer,
            details_view,
            footer: Custom::new(app, Footer::new(theme.clone())).absolute(),
            overlay: OverlayWidgets::new(app, theme, inbox),
        };
        app.root()
            .bg(color(theme.bg))
            .add(&widgets.backdrop)
            .add(&widgets.sidebar.pane)
            .add(&widgets.history)
            .add(&widgets.diff)
            .add(&widgets.details)
            .add(&widgets.footer);
        widgets.sidebar.attach_overlays(&app.root());
        widgets.header.attach(&app.root());
        widgets.overlay.attach(&app.root());
        widgets.history.focus();
        widgets
    }
}

pub(crate) fn place(widget: &impl Widget, left: i64, top: i64, width: i64, height: i64) {
    let cells = |value: i64| u32::try_from(value.max(0)).unwrap_or(0);
    widget
        .position(Edge::Left, cells(left))
        .position(Edge::Top, cells(top))
        .width(cells(width))
        .height(cells(height));
}

impl Shell {
    pub fn sync(&mut self, app: &App) {
        if self.dirty.contains(Dirty::LAYOUT) {
            let panes = self.layout.panes;
            let top = i64::from(PANE_TOP);
            let (width, height) = (i64::from(self.layout.width), i64::from(self.layout.height));
            let widgets = &self.widgets;
            place(&widgets.backdrop, 0, 0, width, height);
            widgets.header.place(width, top);
            place(
                &widgets.details,
                panes.details_left,
                top,
                panes.details_width,
                panes.divider_height,
            );
            place(&widgets.footer, 0, height - 1, width, 1);
            let cells = |value: i64| u32::try_from(value.max(0)).unwrap_or(0);
            let sidebar = panes
                .sidebar_visible
                .then(|| (0, cells(panes.sidebar_width)));
            let details = panes
                .details_visible
                .then(|| (cells(panes.details_left), cells(panes.details_width)));
            widgets
                .footer
                .update(|footer| footer.set_panes(sidebar, details));
            place(
                &widgets.history,
                panes.history_content_left,
                top,
                panes.history_content_width,
                panes.history_text_height,
            );
        }
        if self.dirty.contains(Dirty::LAYOUT) {
            self.place_sidebar();
        }
        self.sync_sidebar();
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
        // The commit card height depends on the selected commit, and the files pane starts below the card.
        if self.dirty.contains(Dirty::HISTORY) && self.commit_open() {
            self.dirty |= Dirty::FILES;
        }
        // Details first: the files pane reads where the commit card ends from the same layout.
        if self
            .dirty
            .intersects(Dirty::DETAILS | Dirty::LAYOUT | Dirty::HISTORY | Dirty::FILES)
        {
            self.sync_details();
        }
        self.sync_files();
        self.sync_composer();
        let focused = self.files.focus == crate::screens::files::Focus::History;
        self.widgets
            .history
            .update(|list| list.set_focused(focused));
        self.sync_diff();
        if self.dirty.intersects(Dirty::OVERLAY | Dirty::LAYOUT) {
            self.sync_overlay(app);
        }
        let spinner = self.pr.spinner_frame;
        self.widgets
            .history
            .update(|list| list.set_spinner_frame(spinner));
        if self
            .dirty
            .intersects(Dirty::HISTORY | Dirty::LAYOUT | Dirty::DIFF | Dirty::AVATARS)
        {
            self.sync_graph_avatars(app);
        }
        self.sync_author_photo(app);
        self.sync_spinner(app);
        self.sync_footer(app);
        self.sync_header(app);
        self.dirty = Dirty::empty();
    }
}
