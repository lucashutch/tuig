//! The left sidebar and the pane dividers. Ports `src/ui/runtime-sidebar.ts`, the sidebar half of
//! `src/ui/runtime-paint.ts`, `resizeSidebarPane` and the pane toggles of `src/ui/runtime-layout.ts`, the pull
//! request actions `select`, `open` and `openForCurrentBranch` of `src/ui/runtime-pull-requests.ts`, and the saved
//! layout of `src/ui/runtime-preferences.ts`.
//!
//! The sections, their folds, scroll offsets and sizes live in [`SidebarState`]. [`Shell::sync_sidebar`] builds
//! the rows on screen with `tuig_widgets::sidebar::present_sidebar` and gives them to the widget. The widget
//! reports raw pointer input, and the methods here decide what it means. A press on a branch checks it out or
//! opens its menu, a second press on a worktree or pull request row opens it, and a drag on a divider changes the
//! section sizes.
//!
//! Layout changes save to `layout.json` after [`PERSIST_DELAY`], as TS does.

use crate::screens::popup::style_field;
use crate::shell::{Dirty, Inbox, Msg, PANE_TOP, Shell};
use crate::sync::wire_hover;
use opentui::prelude::*;
use opentui::widget::{Input, View};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tuig_git::pull_request_types::PullRequest;
use tuig_git::types::{Stash, Submodule, Worktree};
use tuig_ui_model::graph_menu::{GraphMenuAction, GraphMenuTarget};
use tuig_ui_model::preferences::{LayoutPreferences, SidebarSections, save_layout_preferences};
use tuig_ui_model::runtime_layout::{
    clamp_details_width, clamp_sidebar_width, details_width_for_drag, sidebar_width_for_drag,
};
use tuig_ui_model::scrollbar::{ScrollbarGrab, scrollbar_drag, scrollbar_grab};
use tuig_ui_model::sidebar::{
    PerSection, Section, SidebarRect, layout_sidebar_sections, resize_sidebar_boundary, section_at,
};
use tuig_ui_model::theme::{Surface, Theme};
use tuig_widgets::history::DOUBLE_CLICK;
use tuig_widgets::pull_requests::{
    PullRequestPanel, SPINNER_FRAMES, pull_request_branch, pull_request_panel,
};
use tuig_widgets::sidebar::{
    DividerEvent, PaneDivider, Sidebar, SidebarEvent, SidebarInput, filtered_branches,
    present_sidebar, row_total,
};

/// Wheel notches within this time scroll a section as one move. `SIDEBAR_SCROLL_INTERVAL_MS`.
pub const SIDEBAR_SCROLL_INTERVAL: Duration = Duration::from_millis(16);
/// Time between the last layout change and the write to disk. `persistLayout`.
pub const PERSIST_DELAY: Duration = Duration::from_millis(150);

/// Which pane divider an event came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DividerSide {
    Left,
    Right,
}

/// What the sidebar widgets ask the shell to do. One variant of [`Msg`].
pub enum SidebarMsg {
    Event(SidebarEvent),
    Divider(DividerSide, DividerEvent),
    FilterChanged,
    FilterSubmit,
    ScrollFlush(Section),
    PersistDue,
    /// The browser did not open for this pull request.
    OpenFailed(u64),
}

/// The sidebar pane, its two pane dividers and the branch filter box.
pub struct SidebarWidgets {
    pub pane: Custom<Sidebar>,
    pub left_divider: Custom<PaneDivider>,
    pub right_divider: Custom<PaneDivider>,
    pub filter: Input,
}

impl SidebarWidgets {
    pub fn new(app: &App, theme: &Theme, inbox: &Rc<Inbox>) -> Self {
        let mut sidebar = Sidebar::new(theme.clone());
        {
            let inbox = inbox.clone();
            sidebar.on_event(move |cx, event| {
                inbox.post(cx.app(), Msg::Sidebar(SidebarMsg::Event(event)));
            });
        }
        let pane = Custom::new(app, sidebar)
            .absolute()
            .position(Edge::Left, 0u32)
            .position(Edge::Top, u32::from(PANE_TOP));
        let divider = |side: DividerSide| {
            let mut divider = PaneDivider::new(theme.clone());
            let inbox = inbox.clone();
            divider.on_event(move |cx, event| {
                inbox.post(cx.app(), Msg::Sidebar(SidebarMsg::Divider(side, event)));
            });
            let divider = Custom::new(app, divider)
                .absolute()
                .z_index(10)
                .position(Edge::Top, u32::from(PANE_TOP));
            wire_hover(&divider, |divider, entered| divider.set_hovered(entered));
            divider
        };
        let filter = Input::new(app)
            .absolute()
            .z_index(80)
            .position(Edge::Left, 1u32)
            .position(Edge::Top, u32::from(PANE_TOP))
            .height(1)
            .placeholder("Filter branches…")
            // The TS golden (`golden/branch-filter/open.snap`) shows fg=5c6370.
            .visible(false);
        style_field(&filter, theme, theme.selected, Surface::Default);
        {
            let inbox = inbox.clone();
            filter.on_change(move |cx, _| {
                inbox.post(cx.app(), Msg::Sidebar(SidebarMsg::FilterChanged));
            });
        }
        {
            let inbox = inbox.clone();
            filter.on_submit(move |cx, _| {
                inbox.post(cx.app(), Msg::Sidebar(SidebarMsg::FilterSubmit));
            });
        }
        Self {
            pane,
            left_divider: divider(DividerSide::Left),
            right_divider: divider(DividerSide::Right),
            filter,
        }
    }

    pub fn set_theme(&self, theme: &Theme) {
        self.pane.update(|pane| pane.set_theme(theme));
        self.left_divider.update(|divider| divider.set_theme(theme));
        self.right_divider
            .update(|divider| divider.set_theme(theme));
        style_field(&self.filter, theme, theme.selected, Surface::Default);
    }

    /// Adds the dividers and the filter box. The pane goes in at its place among the other panes.
    pub fn attach_overlays(&self, root: &View) {
        root.add(&self.left_divider)
            .add(&self.right_divider)
            .add(&self.filter);
    }

    pub fn key_guard(&self) -> FilterGuard {
        FilterGuard {
            filter: self.filter.clone(),
        }
    }
}

/// Keeps Tab from moving OpenTUI's focus, and Ctrl+C from quitting, while the filter box has the keyboard. TS
/// swallows both while any editor has focus.
#[derive(Clone)]
pub struct FilterGuard {
    filter: Input,
}

impl FilterGuard {
    pub fn apply(&self, cx: &mut Cx<'_>, key: &KeyEvent) {
        if self.filter.is_focused()
            && (key.matches("tab") || key.matches("shift+tab") || key.matches("ctrl+c"))
        {
            cx.prevent_default();
        }
    }
}

pub struct SidebarState {
    theme: Theme,
    /// Remembered content heights. `sidebarPreferred`.
    pub preferred: PerSection<Option<i64>>,
    pub collapsed: PerSection<bool>,
    /// First visible row of each section. `sidebarStart`.
    pub start: PerSection<usize>,
    /// Wheel rows waiting to be applied.
    pending: PerSection<i32>,
    timers: PerSection<Option<TimerId>>,
    /// The section whose scrollbar is being dragged, and where the thumb is held.
    scrollbar: Option<(Section, ScrollbarGrab)>,
    /// The last left press on a submodule, worktree or pull request row, for double clicks.
    last_click: Option<(String, Instant)>,
    /// The branch filter text. It stays after the box closes. `branchFilter`.
    pub filter: String,
    /// The filter box has the keyboard. `branchFilterActive`.
    pub filter_active: bool,
    persist_timer: Option<TimerId>,
    /// Where layout changes are saved. `None` keeps them in memory, as tests do.
    pub prefs_path: Option<PathBuf>,
    /// A visible pull request row shows running checks.
    pub running_checks: bool,
    shown_frame: usize,
}

impl SidebarState {
    pub fn set_theme(&mut self, theme: &Theme) {
        self.theme = theme.clone();
    }

    pub fn new(theme: &Theme) -> Self {
        Self {
            theme: theme.clone(),
            preferred: PerSection::default(),
            collapsed: PerSection::default(),
            start: PerSection::default(),
            pending: PerSection::default(),
            timers: PerSection::default(),
            scrollbar: None,
            last_click: None,
            filter: String::new(),
            filter_active: false,
            persist_timer: None,
            prefs_path: None,
            running_checks: false,
            shown_frame: 0,
        }
    }
}

fn to_sections<T: Copy, U>(
    sections: &SidebarSections<T>,
    convert: impl Fn(T) -> U,
) -> PerSection<Option<U>> {
    PerSection([
        sections.local.map(&convert),
        sections.pull_requests.map(&convert),
        sections.remote.map(&convert),
        sections.submodules.map(&convert),
        sections.stashes.map(&convert),
        sections.worktrees.map(&convert),
    ])
}

fn from_sections<T: Copy, U>(
    sections: &PerSection<T>,
    convert: impl Fn(T) -> U,
) -> SidebarSections<U> {
    SidebarSections {
        local: Some(convert(sections[Section::Local])),
        pull_requests: Some(convert(sections[Section::PullRequests])),
        remote: Some(convert(sections[Section::Remote])),
        submodules: Some(convert(sections[Section::Submodules])),
        stashes: Some(convert(sections[Section::Stashes])),
        worktrees: Some(convert(sections[Section::Worktrees])),
    }
}

impl Shell {
    /// Applies the saved layout at start. `restoreLayout`, plus the clamp that `start()` does once the terminal
    /// size is known.
    pub(crate) fn restore_layout(&mut self, preferences: &LayoutPreferences) {
        let width = i64::from(self.layout.width);
        if let Some(left) = preferences.left_width {
            self.layout.left_width = clamp_sidebar_width(left as i64, width);
        }
        if let Some(details) = preferences.details_width {
            self.layout.details_width = clamp_details_width(details as i64, width);
        }
        self.layout.left_collapsed = preferences.left_collapsed.unwrap_or(false);
        self.layout.details_collapsed = preferences.details_collapsed.unwrap_or(false);
        if let Some(heights) = &preferences.sidebar_heights {
            let saved = to_sections(heights, |height: f64| height as i64);
            for section in Section::ALL {
                if saved[section].is_some() {
                    self.sidebar.preferred[section] = saved[section];
                }
            }
        }
        if let Some(collapsed) = &preferences.sidebar_collapsed {
            let saved = to_sections(collapsed, |flag: bool| flag);
            for section in Section::ALL {
                if let Some(flag) = saved[section] {
                    self.sidebar.collapsed[section] = flag;
                }
            }
        }
        if let Some(columns) = &preferences.history_columns {
            self.history.columns = self.history.columns.with_saved(columns);
        }
        self.layout.recompute();
    }

    pub(crate) fn sidebar_msg(&mut self, app: &App, msg: SidebarMsg) {
        match msg {
            SidebarMsg::Event(event) => self.sidebar_event(app, event),
            SidebarMsg::Divider(side, event) => self.divider_event(app, side, event),
            SidebarMsg::FilterChanged => self.update_branch_filter(),
            SidebarMsg::FilterSubmit => self.activate_filtered_branch(app),
            SidebarMsg::ScrollFlush(section) => self.flush_sidebar_scroll(section),
            SidebarMsg::PersistDue => {
                self.sidebar.persist_timer = None;
                self.flush_layout();
            }
            SidebarMsg::OpenFailed(number) => {
                self.notify_error(format!("Could not open #{number} in a browser"))
            }
        }
    }

    fn sidebar_event(&mut self, app: &App, event: SidebarEvent) {
        match event {
            SidebarEvent::Toggle(section) => {
                self.sidebar.collapsed[section] = !self.sidebar.collapsed[section];
                self.persist_layout(app);
                self.dirty |= Dirty::SIDEBAR;
            }
            SidebarEvent::Press {
                x,
                y,
                button,
                screen,
            } => {
                self.sidebar.scrollbar = None;
                if button == MouseButton::Left && self.press_sidebar_scrollbar(x, y) {
                    return;
                }
                self.sidebar_click(app, y, button, screen);
            }
            SidebarEvent::Drag { y } => self.drag_sidebar_scrollbar(y),
            SidebarEvent::Release => self.sidebar.scrollbar = None,
            SidebarEvent::Wheel { y, delta } => self.sidebar_scroll(app, y, delta),
            SidebarEvent::Resize { section, y } => {
                let rects = self.sidebar_rects();
                self.sidebar.preferred = resize_sidebar_boundary(
                    &rects,
                    &self.sidebar.preferred,
                    &self.sidebar.collapsed,
                    section,
                    y,
                );
                self.persist_layout(app);
                self.dirty |= Dirty::SIDEBAR;
            }
        }
    }

    fn divider_event(&mut self, app: &App, side: DividerSide, event: DividerEvent) {
        match (side, event) {
            (DividerSide::Left, DividerEvent::Drag { x }) => {
                self.layout.left_width =
                    sidebar_width_for_drag(i64::from(x), i64::from(self.layout.width));
                self.layout.left_collapsed = false;
                self.layout_changed(app);
            }
            (DividerSide::Right, DividerEvent::Drag { x }) => {
                self.layout.details_width =
                    details_width_for_drag(i64::from(x), i64::from(self.layout.width));
                self.layout.details_collapsed = false;
                self.layout_changed(app);
            }
            (DividerSide::Left, DividerEvent::Toggle) => self.toggle_left_panel(app),
            (DividerSide::Right, DividerEvent::Toggle) => self.toggle_details_panel(app),
        }
    }

    /// Collapses or expands the sidebar and saves the choice. `toggleSidebarPane`.
    pub(crate) fn toggle_left_panel(&mut self, app: &App) {
        self.layout.left_collapsed = !self.layout.left_collapsed;
        self.layout_changed(app);
    }

    /// Collapses or expands the details pane and saves the choice. `toggleDetailsPane`.
    pub(crate) fn toggle_details_panel(&mut self, app: &App) {
        self.layout.details_collapsed = !self.layout.details_collapsed;
        self.layout_changed(app);
    }

    /// The `[` and `]` keys. TS changes the panes without saving them, and the next save picks the change up.
    pub(crate) fn toggle_panel_key(&mut self, left: bool) {
        if left {
            self.layout.left_collapsed = !self.layout.left_collapsed;
        } else {
            self.layout.details_collapsed = !self.layout.details_collapsed;
        }
        self.panes_moved();
    }

    fn layout_changed(&mut self, app: &App) {
        self.persist_layout(app);
        self.panes_moved();
    }

    /// Lays the panes out again after a width or fold change.
    fn panes_moved(&mut self) {
        self.layout.recompute();
        self.dirty |=
            Dirty::LAYOUT | Dirty::HISTORY | Dirty::DETAILS | Dirty::SIDEBAR | Dirty::OVERLAY;
    }

    /// The saved layout as of now. Fields other screens own stay as they are in the file.
    fn layout_preferences(&self) -> LayoutPreferences {
        LayoutPreferences {
            left_width: Some(self.layout.left_width as f64),
            details_width: Some(self.layout.details_width as f64),
            left_collapsed: Some(self.layout.left_collapsed),
            details_collapsed: Some(self.layout.details_collapsed),
            sidebar_heights: Some(SidebarSections {
                local: self.sidebar.preferred[Section::Local].map(|v| v as f64),
                pull_requests: self.sidebar.preferred[Section::PullRequests].map(|v| v as f64),
                remote: self.sidebar.preferred[Section::Remote].map(|v| v as f64),
                submodules: self.sidebar.preferred[Section::Submodules].map(|v| v as f64),
                stashes: self.sidebar.preferred[Section::Stashes].map(|v| v as f64),
                worktrees: self.sidebar.preferred[Section::Worktrees].map(|v| v as f64),
            }),
            sidebar_collapsed: Some(from_sections(&self.sidebar.collapsed, |flag| flag)),
            history_columns: Some(self.history.columns.to_preferences()),
            ..LayoutPreferences::default()
        }
    }

    /// Saves the layout after [`PERSIST_DELAY`]. A new change restarts the wait. `persistLayout`.
    pub(crate) fn persist_layout(&mut self, app: &App) {
        if self.sidebar.prefs_path.is_none() {
            return;
        }
        if let Some(timer) = self.sidebar.persist_timer.take() {
            app.cancel_timer(timer);
        }
        let inbox = self.inbox.clone();
        self.sidebar.persist_timer = Some(app.set_timeout(PERSIST_DELAY, move |cx| {
            inbox.post(cx.app(), Msg::Sidebar(SidebarMsg::PersistDue))
        }));
    }

    /// Writes the layout now. `flushLayout`. A write that fails is dropped, as in TS.
    pub(crate) fn flush_layout(&mut self) {
        let Some(path) = self.sidebar.prefs_path.clone() else {
            return;
        };
        let _ = save_layout_preferences(&self.layout_preferences(), &path);
    }

    /// Writes a layout change that has not been saved yet. Runs before the app quits.
    pub(crate) fn flush_pending_layout(&mut self, app: &App) {
        if let Some(timer) = self.sidebar.persist_timer.take() {
            app.cancel_timer(timer);
            self.flush_layout();
        }
    }

    // Geometry.

    fn sidebar_hidden(&self) -> PerSection<bool> {
        let mut hidden = PerSection::<bool>::default();
        hidden[Section::PullRequests] =
            matches!(self.pull_request_panel(), PullRequestPanel::Hidden);
        hidden
    }

    /// The pull request section's content. `panel`.
    pub(crate) fn pull_request_panel(&self) -> PullRequestPanel {
        pull_request_panel(self.pr.service.is_some(), self.pr.result.as_ref())
    }

    /// Section geometry for the current size. `sidebarLayout`.
    pub(crate) fn sidebar_rects(&self) -> PerSection<SidebarRect> {
        layout_sidebar_sections(
            crate::shell::LayoutState::content_height_for(self.layout.height),
            &self.sidebar.preferred,
            &self.sidebar.collapsed,
            &self.sidebar_hidden(),
        )
    }

    fn sidebar_total(&self, section: Section) -> usize {
        let Some(snapshot) = &self.snapshot else {
            return 0;
        };
        row_total(
            snapshot,
            section,
            &self.pull_request_panel(),
            &self.sidebar.filter,
        )
    }

    // Scrolling.

    /// Queues wheel rows for the section under `y`. Notches within [`SIDEBAR_SCROLL_INTERVAL`] move it once.
    fn sidebar_scroll(&mut self, app: &App, y: i64, delta: i32) {
        if self.snapshot.is_none() {
            return;
        }
        let Some(section) = section_at(&self.sidebar_rects(), y) else {
            return;
        };
        if self.sidebar.collapsed[section] {
            return;
        }
        self.sidebar.pending[section] += delta;
        if self.sidebar.timers[section].is_some() {
            return;
        }
        let inbox = self.inbox.clone();
        self.sidebar.timers[section] = Some(app.set_timeout(SIDEBAR_SCROLL_INTERVAL, move |cx| {
            inbox.post(cx.app(), Msg::Sidebar(SidebarMsg::ScrollFlush(section)))
        }));
    }

    fn flush_sidebar_scroll(&mut self, section: Section) {
        self.sidebar.timers[section] = None;
        let movement = std::mem::take(&mut self.sidebar.pending[section]);
        self.apply_sidebar_scroll(section, movement);
    }

    /// Moves one section's viewport, clamped to its rows. Sizes can change while a batch waits, so it measures now.
    fn apply_sidebar_scroll(&mut self, section: Section, delta: i32) {
        if self.snapshot.is_none() || delta == 0 {
            return;
        }
        let height = self.sidebar_rects()[section].content_height;
        let limit = (self.sidebar_total(section) as i64 - height).max(0);
        let next = (self.sidebar.start[section] as i64 + i64::from(delta)).clamp(0, limit);
        self.sidebar.start[section] = next as usize;
        self.dirty |= Dirty::SIDEBAR;
    }

    /// Drops queued wheel rows, for use when the contents change. `cancelSidebarScroll`.
    fn cancel_sidebar_scroll(&mut self, app: &App) {
        for section in Section::ALL {
            if let Some(timer) = self.sidebar.timers[section].take() {
                app.cancel_timer(timer);
            }
            self.sidebar.pending[section] = 0;
        }
    }

    /// Starts a scrollbar drag when a left press lands on a section's last column. Returns whether it took the
    /// press. `pressSidebarScrollbar`.
    fn press_sidebar_scrollbar(&mut self, x: i64, y: i64) -> bool {
        if self.snapshot.is_none() || x != self.layout.panes.sidebar_width - 1 {
            return false;
        }
        let rects = self.sidebar_rects();
        let Some(section) = section_at(&rects, y) else {
            return false;
        };
        let rect = rects[section];
        let total = self.sidebar_total(section) as i64;
        if total <= rect.content_height {
            return false;
        }
        // A press ends any queued wheel rows for the section.
        self.sidebar.pending[section] = 0;
        self.sidebar.scrollbar = Some((
            section,
            scrollbar_grab(
                total,
                self.sidebar.start[section] as i64,
                rect.content_height,
                y - rect.content_top,
            ),
        ));
        self.drag_sidebar_scrollbar(y);
        true
    }

    /// Moves the dragged section with the pointer. The section can resize or reload mid-drag, so it measures each
    /// time. `dragSidebarScrollbar`.
    fn drag_sidebar_scrollbar(&mut self, y: i64) {
        let Some((section, grab)) = self.sidebar.scrollbar else {
            return;
        };
        let rect = self.sidebar_rects()[section];
        let (start, grab) = scrollbar_drag(
            &grab,
            self.sidebar_total(section) as i64,
            self.sidebar.start[section] as i64,
            rect.content_height,
            y - rect.content_top,
        );
        self.sidebar.scrollbar = Some((section, grab));
        if start as usize != self.sidebar.start[section] {
            self.sidebar.start[section] = start.max(0) as usize;
            self.dirty |= Dirty::SIDEBAR;
        }
    }

    // Clicks.

    /// Whether this press completes a double click on `key`. Any press ends a pending one, and a left press on a
    /// row that opens on a double click arms the next.
    fn double_click(&mut self, previous: &Option<(String, Instant)>, key: String) -> bool {
        let now = Instant::now();
        if previous
            .as_ref()
            .is_some_and(|(last, at)| *last == key && now.duration_since(*at) < DOUBLE_CLICK)
        {
            return true;
        }
        self.sidebar.last_click = Some((key, now));
        false
    }

    /// A press on a row. `y` is pane-local and `screen` is where a menu opens. `sidebarClick`.
    fn sidebar_click(&mut self, app: &App, y: i64, button: MouseButton, screen: (u16, u16)) {
        let Some(snapshot) = self.snapshot.clone() else {
            return;
        };
        let rects = self.sidebar_rects();
        let Some(section) = section_at(&rects, y) else {
            return;
        };
        let row = (self.sidebar.start[section] as i64 + y - rects[section].content_top) as usize;
        let previous = self.sidebar.last_click.take();
        let (x, y) = (i64::from(screen.0), i64::from(screen.1));
        let left = button == MouseButton::Left;
        match section {
            Section::PullRequests => {
                let PullRequestPanel::List(list) = self.pull_request_panel() else {
                    return;
                };
                let Some(pull_request) = list.get(row).filter(|_| left) else {
                    return;
                };
                // The first press selects the head commit and a second one opens the page.
                if self.double_click(&previous, format!("pull-request:{}", pull_request.number)) {
                    self.open_pull_request(app, pull_request);
                } else {
                    self.select_pull_request(pull_request);
                }
            }
            Section::Submodules => {
                let Some(submodule) = snapshot.submodules.get(row / 2) else {
                    return;
                };
                if !left {
                    self.open_graph_menu(x, y, submodule_target(submodule));
                } else if self.double_click(&previous, format!("submodule:{}", submodule.path)) {
                    self.run_menu_action(
                        app,
                        GraphMenuAction::OpenSubmodule,
                        submodule_target(submodule),
                    );
                }
            }
            Section::Stashes => {
                // A press with either button opens the menu. A stash takes two rows.
                if let Some(stash) = snapshot.stashes.get(row / 2) {
                    self.open_graph_menu(x, y, stash_target(stash));
                }
            }
            Section::Worktrees => {
                let Some(worktree) = snapshot.worktrees.get(row / 2) else {
                    return;
                };
                if !left {
                    self.open_graph_menu(x, y, worktree_target(worktree));
                } else if self.double_click(&previous, format!("worktree:{}", worktree.path)) {
                    self.run_menu_action(
                        app,
                        GraphMenuAction::OpenWorktree,
                        worktree_target(worktree),
                    );
                }
            }
            Section::Local | Section::Remote => {
                let Some(branch) = filtered_branches(&snapshot, section, &self.sidebar.filter)
                    .get(row)
                    .map(|branch| (*branch).clone())
                else {
                    return;
                };
                if left {
                    self.checkout_branch(app, branch);
                } else {
                    self.open_graph_menu(
                        x,
                        y,
                        GraphMenuTarget {
                            sha: branch.sha.clone(),
                            branch: Some(branch),
                            ..GraphMenuTarget::default()
                        },
                    );
                }
            }
        }
    }

    // Pull requests.

    /// Selects the pull request's head in the graph without a checkout. `select`.
    fn select_pull_request(&mut self, pull_request: &PullRequest) {
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        let by_branch =
            pull_request_branch(pull_request, &snapshot.branches).map(|branch| branch.sha.clone());
        // A head commit outside the loaded history would need an unbounded walk, so only one on screen is used.
        let by_head = pull_request
            .head_sha
            .clone()
            .filter(|sha| self.history.commits.iter().any(|commit| &commit.sha == sha));
        match by_branch.or(by_head) {
            Some(sha) => self.focus_commit(sha),
            None => self.notify(format!(
                "Branch for #{} is not fetched",
                pull_request.number
            )),
        }
    }

    /// Selects a commit and centers it once it is loaded. History pages in until it appears. `focusCommit`.
    fn focus_commit(&mut self, sha: String) {
        self.history.focus_sha = Some(sha);
        self.focus_head();
        // With the commit view open, the new commit opens in it.
        if self.history.focus_sha.is_none() && self.commit_open() {
            self.open_commit();
        }
    }

    /// Opens the pull request's page in the browser. `open`.
    pub(crate) fn open_pull_request(&mut self, app: &App, pull_request: &PullRequest) {
        let Some(opener) = self.pr.opener.clone() else {
            return;
        };
        let url = pull_request.url.clone();
        let number = pull_request.number;
        let inbox = self.inbox.clone();
        app.spawn(async move { opener.open(&url).await }, move |cx, result| {
            if result.is_err() {
                inbox.post(cx.app(), Msg::Sidebar(SidebarMsg::OpenFailed(number)));
            }
        });
    }

    /// The palette entry: opens the pull request of the checked-out branch. `openForCurrentBranch`.
    pub(crate) fn open_current_pull_request(&mut self, app: &App) {
        match self.pull_request_for_current_branch().cloned() {
            Some(pull_request) => self.open_pull_request(app, &pull_request),
            None => self.notify("No open pull request for the current branch"),
        }
    }

    // The branch filter.

    /// Shows the filter box and gives it the keyboard. `startBranchFilter`.
    pub(crate) fn start_branch_filter(&mut self, app: &App) {
        if self.commit_open() {
            return self.notify("Branch filter is available from the graph");
        }
        self.layout.left_collapsed = false;
        self.sidebar.filter_active = true;
        self.layout.branch_filter_active = true;
        let filter = &self.widgets.sidebar.filter;
        filter.set_value(&self.sidebar.filter);
        filter.visible(true);
        self.panes_moved();
        // The box needs its size before it takes the keyboard.
        self.sync(app);
        self.widgets.sidebar.filter.focus();
    }

    /// Hides the filter box. The text stays applied. `finishBranchFilter`.
    pub(crate) fn finish_branch_filter(&mut self, app: &App) {
        if !self.sidebar.filter_active {
            return;
        }
        self.sidebar.filter_active = false;
        self.layout.branch_filter_active = false;
        self.widgets.sidebar.filter.visible(false);
        app.focus(&self.widgets.history);
        self.panes_moved();
    }

    /// Applies the box text and resets the scroll. `updateBranchFilter`.
    fn update_branch_filter(&mut self) {
        self.sidebar.filter = self.widgets.sidebar.filter.value();
        self.sidebar.start[Section::Local] = 0;
        self.sidebar.start[Section::Remote] = 0;
        self.sidebar.pending = PerSection::default();
        self.dirty |= Dirty::SIDEBAR;
    }

    /// Clears the filter and hides the box. `cancelBranchFilter`.
    pub(crate) fn cancel_branch_filter(&mut self, app: &App) {
        self.cancel_sidebar_scroll(app);
        self.sidebar.filter.clear();
        self.widgets.sidebar.filter.set_value("");
        self.sidebar.start[Section::Local] = 0;
        self.sidebar.start[Section::Remote] = 0;
        self.dirty |= Dirty::SIDEBAR;
        self.finish_branch_filter(app);
    }

    /// Enter in the box: checks out the first matching local branch. `activateFilteredBranch`.
    fn activate_filtered_branch(&mut self, app: &App) {
        let Some(snapshot) = &self.snapshot else {
            return self.finish_branch_filter(app);
        };
        let branch = filtered_branches(snapshot, Section::Local, &self.sidebar.filter)
            .first()
            .map(|branch| (*branch).clone());
        self.finish_branch_filter(app);
        if let Some(branch) = branch {
            self.checkout_branch(app, branch);
        }
    }

    /// Keys while the filter box has the keyboard. It uses up every key but Esc and Ctrl+P, which TS handles
    /// before it checks for an editor. Returns true when the key is used up.
    pub(crate) fn branch_filter_key(&mut self, app: &App, key: &KeyEvent) -> bool {
        use opentui::input::KeyEventKind;
        if !self.sidebar.filter_active {
            return false;
        }
        if key.matches("ctrl+p") {
            return false;
        }
        if key.kind != KeyEventKind::Release && (key.matches("esc") || key.matches("escape")) {
            self.cancel_branch_filter(app);
        }
        true
    }

    // Painting.

    /// Pushes the sidebar and the dividers into their widgets.
    pub(crate) fn sync_sidebar(&mut self) {
        let panes = self.layout.panes;
        let filter = &self.widgets.sidebar.filter;
        let _ = filter.visible(panes.branch_filter_visible);
        if panes.branch_filter_visible {
            crate::sync::place(
                filter,
                panes.branch_filter_left,
                i64::from(PANE_TOP) + panes.branch_filter_top_offset,
                panes.branch_filter_width,
                1,
            );
        }
        let frame_moved =
            self.sidebar.running_checks && self.sidebar.shown_frame != self.pr.spinner_frame;
        if !(self
            .dirty
            .intersects(Dirty::SIDEBAR | Dirty::LAYOUT | Dirty::HISTORY)
            || frame_moved)
        {
            return;
        }
        let view = match &self.snapshot {
            Some(snapshot) => {
                let panel = self.pull_request_panel();
                let frame = SPINNER_FRAMES[self.pr.spinner_frame % SPINNER_FRAMES.len()];
                let presented = present_sidebar(&SidebarInput {
                    snapshot,
                    refs: &self.history.refs,
                    panel: &panel,
                    theme: &self.sidebar.theme,
                    spinner_frame: frame,
                    rects: self.sidebar_rects(),
                    collapsed: self.sidebar.collapsed,
                    start: self.sidebar.start,
                    width: panes.sidebar_width,
                    filter: &self.sidebar.filter,
                });
                self.sidebar.start = presented.start;
                self.sidebar.running_checks = presented.running_checks;
                presented.view
            }
            None => Default::default(),
        };
        self.sidebar.shown_frame = self.pr.spinner_frame;
        self.widgets
            .sidebar
            .pane
            .update(|pane| pane.set_view(Rc::new(view)));
    }

    /// Places the sidebar and the two dividers. `layoutRuntime`.
    pub(crate) fn place_sidebar(&self) {
        let panes = self.layout.panes;
        let top = i64::from(PANE_TOP);
        let widgets = &self.widgets.sidebar;
        let _ = widgets.pane.visible(panes.sidebar_visible);
        crate::sync::place(
            &widgets.pane,
            0,
            top,
            panes.sidebar_width,
            crate::shell::LayoutState::content_height_for(self.layout.height),
        );
        crate::sync::place(
            &widgets.left_divider,
            panes.left_divider_left,
            top,
            panes.left_divider_width,
            panes.divider_height,
        );
        let theme = &self.sidebar.theme;
        let left_cells = panes.left_divider_width as usize;
        widgets.left_divider.update(|divider| {
            divider.set_bar_column(panes.left_divider_bar_left - panes.left_divider_left);
            divider.set_backdrop(vec![theme.bg; left_cells]);
        });
        // The right divider's hit box is three cells wide, as in TS, and the bar is its middle cell.
        crate::sync::place(
            &widgets.right_divider,
            panes.right_divider_left,
            top,
            3,
            panes.divider_height,
        );
        widgets.right_divider.update(|divider| {
            divider.set_bar_column(panes.right_divider_bar_left - panes.right_divider_left);
            divider.set_backdrop(vec![theme.bg, theme.bg]);
        });
    }
}

fn submodule_target(submodule: &Submodule) -> GraphMenuTarget {
    GraphMenuTarget {
        sha: submodule.sha.clone(),
        submodule: Some(submodule.clone()),
        ..GraphMenuTarget::default()
    }
}

fn stash_target(stash: &Stash) -> GraphMenuTarget {
    GraphMenuTarget {
        sha: stash.sha.clone(),
        stash: Some(stash.clone()),
        ..GraphMenuTarget::default()
    }
}

fn worktree_target(worktree: &Worktree) -> GraphMenuTarget {
    GraphMenuTarget {
        sha: worktree.sha.clone(),
        worktree: Some(worktree.clone()),
        ..GraphMenuTarget::default()
    }
}

#[cfg(test)]
#[path = "sidebar_tests.rs"]
mod tests;
