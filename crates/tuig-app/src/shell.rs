//! The shell: one [`Shell`] value holds all UI state, every input becomes a [`Msg`], and [`Shell::update`] is the
//! only place that changes state. [`Shell::sync`](crate::sync) then pushes the changed state into widgets.
//!
//! Re-entrancy rule: no callback calls `update` directly. Widget callbacks, timers, task completions and watcher
//! messages post a [`Msg`] to the [`Inbox`]. The inbox drains after the current handler returns (`App::defer`),
//! runs `update` for each message, and calls `sync` once when the queue is empty. So `sync` never calls
//! `Custom::update` on a widget whose handler is still running, and no handler borrows the shell twice.

use crate::keys::{self, Command};
use crate::refresh::{RefreshState, WatchSignal};
use crate::screens::commands::CommandsState;
use crate::screens::composer::{ComposerAction, ComposerState};
use crate::screens::details::{DetailsAction, DetailsState, HistoryLoaded};
use crate::screens::diff::DiffState;
use crate::screens::files::{ChangesAction, FilesState, Focus, Split};
use crate::screens::footer::FooterState;
use crate::screens::graph_avatars::{AvatarLoaded, AvatarState, PhotoLoaded, ProviderLoaded};
use crate::screens::header::{HeaderMsg, HeaderState};
use crate::screens::history::HistoryState;
use crate::screens::popup::{OverlayMsg, OverlayState};
use crate::screens::pull_requests::PullRequestsState;
use crate::screens::sidebar::{SidebarMsg, SidebarState};
use crate::screens::theme::ThemeState;
use crate::selected_file::SelectedFile;
use crate::services::Services;
use crate::sync::Widgets;
use crate::tasks::{ReqId, Slot, Tasks};
use bitflags::bitflags;
use opentui::prelude::*;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::future::Future;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use tuig_git::process::GitError;
use tuig_git::pull_request_types::PullRequestList;
use tuig_git::repository::GitRepository;
use tuig_git::types::{
    ChangedFile, CommitPage, HistoryHead, LineBlame, RepositorySnapshot, RepositoryWatchPaths,
};
use tuig_ui_model::file_tree::FileRowAction;
use tuig_ui_model::history_viewport::history_lines;
use tuig_ui_model::runtime_layout::{PaneInputs, PaneLayout, layout_panes};
use tuig_ui_model::theme_resolver::ThemeMode;
use tuig_widgets::diff::{DiffDocument, DiffEvent};
use tuig_widgets::files::ListKind;
use tuig_widgets::history::{ClickPart, HistoryEvent};

/// The terminal's appearance in the terms of `tuig-ui-model`.
fn appearance(mode: opentui::prelude::ThemeMode) -> ThemeMode {
    match mode {
        opentui::prelude::ThemeMode::Light => ThemeMode::Light,
        opentui::prelude::ThemeMode::Dark => ThemeMode::Dark,
    }
}

/// The colors OpenTUI gives new widgets and the screen background, from a tuig theme. `renderer.setBackgroundColor`.
pub(crate) fn app_theme(theme: &tuig_ui_model::theme::Theme) -> opentui::prelude::Theme {
    let color = |c: tuig_ui_model::color::Rgba| Color::rgba(c.r, c.g, c.b, c.a);
    let base = match opentui::prelude::ThemeMode::from_background(color(theme.bg)) {
        opentui::prelude::ThemeMode::Light => opentui::prelude::Theme::light(),
        opentui::prelude::ThemeMode::Dark => opentui::prelude::Theme::dark(),
    };
    opentui::prelude::Theme {
        background: color(theme.bg),
        surface: color(theme.panel),
        foreground: color(theme.text),
        muted: color(theme.muted),
        accent: color(theme.accent),
        border: color(theme.border),
        focus: color(theme.focus_ring),
        selection_bg: color(theme.selected),
        ..base
    }
}

pub type GitResult<T> = Result<T, GitError>;

/// Rows above the panes: the tab strip and the two toolbar rows. `PANE_TOP` in `src/ui/runtime-widgets.ts`.
pub const PANE_TOP: u16 = 3;
/// Default pane widths. `leftWidth` and `detailsWidth` in `src/ui/runtime.ts`.
const LEFT_WIDTH: i64 = 28;
const DETAILS_WIDTH: i64 = 44;

/// The terminal window title, `tuig · <repository root>`. `renderer.setTerminalTitle` in `src/ui/runtime.ts`.
pub(crate) fn window_title(root: &str) -> String {
    format!("tuig · {root}")
}

pub enum Msg {
    Key(KeyEvent),
    HistoryClick {
        row: usize,
        part: ClickPart,
        clicks: u8,
    },
    HistoryWheel(i32),
    /// A header or scrollbar event of the history list.
    HistoryPointer(HistoryEvent),
    HistoryScrollGraph(i32),
    FileClick {
        section: ListKind,
        row: usize,
    },
    FileWheel {
        section: ListKind,
        delta: i32,
    },
    FileToggleSection(ListKind),
    /// A hover action on a file row. Staging handles it.
    FileRowAction {
        section: ListKind,
        row: usize,
        action: FileRowAction,
    },
    /// Discard all, Stage all or Unstage all. Staging handles it.
    ChangesAction(ChangesAction),
    SplitDrag {
        split: Split,
        y: u16,
    },
    Resize(u16, u16),
    /// The terminal changed between a light and a dark background.
    TerminalAppearance(ThemeMode),
    Details(DetailsAction),
    Composer(ComposerAction),
    FileHistoryClick(usize),
    FileHistoryWheel(i64),
    DiffInput(DiffEvent),
    /// Menus, the palette and the prompts. See `screens/popup.rs`.
    Overlay(OverlayMsg),
    /// The sidebar, the pane dividers and the branch filter. See `screens/sidebar.rs`.
    Sidebar(SidebarMsg),
    /// The tab strip, the toolbar and the repository picker. See `screens/header.rs`.
    Header(HeaderMsg),

    Snapshot(ReqId, GitResult<RepositorySnapshot>),
    /// The history page and refs of the first snapshot, ahead of `git status`.
    HistoryHead(ReqId, HistoryHead),
    CommitPage(ReqId, GitResult<CommitPage>),
    WatchPaths(ReqId, GitResult<Option<RepositoryWatchPaths>>),
    /// The Git directory of a large repository without a commit-graph, or `None`.
    CommitGraphHint(ReqId, GitResult<Option<String>>),
    CommitFiles(ReqId, GitResult<Vec<ChangedFile>>),
    CommitFilesDue,

    /// The highlighted file changed. Posted once per change, with `None` when no file is selected. An open diff
    /// follows it. A closed diff stays closed, as in TS.
    FileSelected(Option<SelectedFile>),
    /// The user opened a file: a click on a file row, or Enter in the changes pane. The diff pane shows it.
    FileOpened(SelectedFile),
    FileHistory(ReqId, HistoryLoaded),
    Blame(ReqId, GitResult<LineBlame>),
    Diff(ReqId, GitResult<DiffDocument>),
    Mutation(ReqId, GitResult<()>),
    PullRequests(ReqId, PullRequestList),
    /// A loaded avatar. It carries its own slot and claim token instead of a `ReqId`, because every graph row has
    /// its own task.
    GraphAvatar(AvatarLoaded),
    AuthorPhoto(PhotoLoaded),
    ProviderBadge(ProviderLoaded),

    PullRequestsDue,
    SpinnerTick,
    /// The message in the footer has been up for its six seconds. Carries the generation of the timer.
    NoticeExpired(u64),
    BackgroundFetch,
    ScrollFlush,
    ScrollSettled,
    Poll,

    Watch {
        generation: u64,
        event: WatchSignal,
    },
}

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Dirty: u16 {
        const LAYOUT = 1;
        const SIDEBAR = 2;
        const HISTORY = 4;
        const FILES = 16;
        const DETAILS = 32;
        const DIFF = 64;
        const OVERLAY = 128;
        const COMPOSER = 256;
        /// Graph avatars need another look: a wheel gesture ended or the terminal reported its graphics support.
        const AVATARS = 1024;
    }
}

/// Messages waiting for the shell. Shared by every callback; never borrowed across a call into the shell.
pub struct Inbox {
    queue: RefCell<VecDeque<Msg>>,
    scheduled: Cell<bool>,
    shell: RefCell<Weak<RefCell<Shell>>>,
}

impl Inbox {
    /// Queues `msg` and schedules a drain after the current handler.
    pub fn post(self: &Rc<Self>, app: &App, msg: Msg) {
        self.queue.borrow_mut().push_back(msg);
        if !self.scheduled.replace(true) {
            let inbox = self.clone();
            app.defer(move |cx| inbox.drain(cx.app()));
        }
    }

    /// Runs `update` for every queued message, then `sync` once.
    pub fn drain(&self, app: &App) {
        self.scheduled.set(false);
        let Some(shell) = self.shell.borrow().upgrade() else {
            return;
        };
        loop {
            let msg = self.queue.borrow_mut().pop_front();
            match msg {
                Some(msg) => shell.borrow_mut().update(app, msg),
                None => break,
            }
        }
        shell.borrow_mut().sync(app);
    }
}

pub struct LayoutState {
    pub width: u16,
    pub height: u16,
    pub panes: PaneLayout,
    /// The palette toggles these. `leftCollapsed` and `detailsCollapsed`.
    pub left_collapsed: bool,
    pub details_collapsed: bool,
    /// Width of the sidebar when it is open. The divider drag and the saved layout set it. `leftWidth`.
    pub left_width: i64,
    pub details_width: i64,
    /// The branch filter box is open, so it needs room in the layout. `branchFilterActive`.
    pub branch_filter_active: bool,
}

impl LayoutState {
    fn new(width: u16, height: u16) -> Self {
        let mut layout = Self {
            width,
            height,
            panes: layout_panes(PaneInputs {
                terminal_width: i64::from(width),
                left_width: LEFT_WIDTH,
                details_width: DETAILS_WIDTH,
                left_collapsed: false,
                details_collapsed: false,
                content_height: Self::content_height_for(height),
                branch_filter_active: false,
            }),
            left_collapsed: false,
            details_collapsed: false,
            left_width: LEFT_WIDTH,
            details_width: DETAILS_WIDTH,
            branch_filter_active: false,
        };
        layout.recompute();
        layout
    }

    pub(crate) fn recompute(&mut self) {
        self.panes = layout_panes(PaneInputs {
            terminal_width: i64::from(self.width),
            left_width: self.left_width,
            details_width: self.details_width,
            left_collapsed: self.left_collapsed,
            details_collapsed: self.details_collapsed,
            content_height: Self::content_height_for(self.height),
            branch_filter_active: self.branch_filter_active,
        });
    }

    fn resize(&mut self, width: u16, height: u16) {
        self.width = width;
        self.height = height;
        self.recompute();
    }

    pub(crate) fn content_height_for(height: u16) -> i64 {
        (i64::from(height) - i64::from(PANE_TOP)).max(1)
    }

    /// History body lines, the same count the widget paints.
    pub fn history_lines(&self) -> usize {
        history_lines(Self::content_height_for(self.height))
    }
}

pub struct Shell {
    pub repo: Arc<dyn GitRepository>,
    /// The latest snapshot. Its `commits` are moved into `history.commits`, which paging extends.
    pub snapshot: Option<RepositorySnapshot>,
    pub history: HistoryState,
    pub files: FilesState,
    pub details: DetailsState,
    pub diff: DiffState,
    pub overlay: OverlayState,
    pub commands: CommandsState,
    pub composer: ComposerState,
    pub layout: LayoutState,
    /// Git directories whose commit-graph notice was shown. See `screens/commit_graph_hint.rs`.
    pub commit_graph_hint_dismissed: Vec<String>,
    pub tasks: Tasks,
    pub refresh: RefreshState,
    pub pr: PullRequestsState,
    pub sidebar: SidebarState,
    pub avatars: AvatarState,
    pub header: HeaderState,
    /// The active theme, the catalog and the saved choice. See `screens/theme.rs`.
    pub themes: ThemeState,
    /// The message for the footer row. It clears after six seconds. See `screens/footer.rs`.
    pub notice: Option<String>,
    pub(crate) footer: FooterState,
    pub(crate) dirty: Dirty,
    pub(crate) widgets: Widgets,
    pub(crate) inbox: Rc<Inbox>,
}

impl Shell {
    /// Builds the widgets, starts the first snapshot and the watcher, and wires input into the inbox. The app uses
    /// [`Shell::start_with`]. This form runs with no outside services, so tests never reach the network.
    #[cfg(test)]
    pub fn start(app: &App, repo: Arc<dyn GitRepository>) -> Rc<RefCell<Shell>> {
        Self::start_with(app, repo, Services::default())
    }

    /// Like [`Shell::start`], with the services that reach outside the repository: pull requests, avatars and the
    /// background fetch.
    pub fn start_with(
        app: &App,
        repo: Arc<dyn GitRepository>,
        services: Services,
    ) -> Rc<RefCell<Shell>> {
        let initial = ThemeState::load(
            services.theme_config.as_deref(),
            Some(std::path::Path::new(repo.root())),
            app.theme_mode().map(appearance),
        );
        let theme = initial.state.theme.clone();
        app.set_theme(app_theme(&theme));
        let inbox = Rc::new(Inbox {
            queue: RefCell::new(VecDeque::new()),
            scheduled: Cell::new(false),
            shell: RefCell::new(Weak::new()),
        });
        let (width, height) = app.size();
        let widgets = Widgets::new(app, &theme, &inbox);
        let key_guard = widgets.composer.key_guard();
        let filter_guard = widgets.sidebar.key_guard();
        let shell = Rc::new(RefCell::new(Shell {
            repo: repo.clone(),
            snapshot: None,
            history: HistoryState::new(&theme),
            files: FilesState::new(),
            details: DetailsState::default(),
            diff: DiffState::new(),
            overlay: OverlayState::default(),
            commands: CommandsState::default(),
            composer: ComposerState::default(),
            layout: LayoutState::new(width, height),
            commit_graph_hint_dismissed: Vec::new(),
            tasks: Tasks::default(),
            refresh: RefreshState::default(),
            pr: PullRequestsState::new(services.pull_requests.clone(), services.url_opener.clone()),
            sidebar: SidebarState::new(&theme),
            avatars: AvatarState::new(services.avatars.clone(), services.avatars_enabled),
            header: HeaderState::new(repo.clone(), services.pull_requests_for),
            themes: initial.state,
            notice: None,
            footer: FooterState::default(),
            dirty: Dirty::all(),
            widgets,
            inbox: inbox.clone(),
        }));
        *inbox.shell.borrow_mut() = Rc::downgrade(&shell);
        app.set_title(&window_title(repo.root()));

        {
            let inbox = inbox.clone();
            app.on_key(move |cx, key| {
                key_guard.apply(cx, key);
                filter_guard.apply(cx, key);
                inbox.post(cx.app(), Msg::Key(*key));
            });
        }
        {
            let inbox = inbox.clone();
            app.on_resize(move |cx, width, height| {
                inbox.post(cx.app(), Msg::Resize(width, height))
            });
        }
        {
            let inbox = inbox.clone();
            app.on_theme_mode(move |cx, mode| {
                inbox.post(cx.app(), Msg::TerminalAppearance(appearance(mode)))
            });
        }
        crate::refresh::install(app, &inbox);

        {
            let mut shell = shell.borrow_mut();
            if let Some(warning) = initial.warning {
                shell.notify_error(warning);
            }
            shell.sidebar.prefs_path = services.layout_path.clone();
            shell.restore_layout(&services.layout);
            shell.start_snapshot(app);
            shell.start_watch_paths(app);
            shell.start_commit_graph_hint(app);
            shell.start_pull_requests(app);
            if let Some(interval) = services.fetch_interval {
                shell.start_background_fetch(app, interval);
            }
        }
        inbox.drain(app);
        shell
    }

    /// Spawns `future` in `slot` and posts its output as `wrap(id, output)`.
    pub(crate) fn spawn<F, T>(
        &mut self,
        app: &App,
        slot: fn(&mut Tasks) -> &mut Slot,
        future: F,
        wrap: fn(ReqId, T) -> Msg,
    ) where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let id = slot(&mut self.tasks).begin();
        let inbox = self.inbox.clone();
        let task = app.spawn(future, move |cx, output| {
            inbox.post(cx.app(), wrap(id, output));
        });
        slot(&mut self.tasks).attach(task);
    }

    pub fn update(&mut self, app: &App, msg: Msg) {
        match msg {
            Msg::Key(key) => {
                if self.overlay_key(app, &key) || self.header_key(app, &key) {
                    return;
                }
                if self.composer_key(&key) || self.branch_filter_key(app, &key) {
                    // A text field has the keyboard.
                } else if let Some(command) = keys::command_for(&key) {
                    self.command(app, command);
                }
            }
            Msg::HistoryClick { row, part, clicks } => {
                self.history_row_pressed(app);
                self.history_click(app, row, part, clicks);
                self.files_history_clicked();
            }
            Msg::FileClick { section, row } => self.file_click(app, section, row),
            Msg::FileWheel { section, delta } => self.file_wheel(section, delta),
            Msg::FileToggleSection(section) => self.file_toggle_section(section),
            Msg::FileRowAction {
                section,
                row,
                action,
            } => self.file_row_action(app, section, row, action),
            Msg::ChangesAction(action) => self.changes_action(app, action),
            Msg::SplitDrag { split, y } => self.split_drag(app, split, y),
            Msg::HistoryWheel(delta) => self.queue_history_scroll(app, delta),
            Msg::HistoryPointer(event) => self.history_pointer(app, event),
            Msg::HistoryScrollGraph(delta) => {
                self.scroll_graph(i64::from(delta));
            }
            Msg::TerminalAppearance(mode) => self.terminal_appearance_changed(app, mode),
            Msg::Resize(width, height) => {
                self.layout.resize(width, height);
                self.dirty |= Dirty::LAYOUT | Dirty::HISTORY | Dirty::DETAILS | Dirty::OVERLAY;
                self.repaint_palette_state();
            }
            Msg::Snapshot(id, result) => {
                if self.tasks.snapshot.finish(id) {
                    self.snapshot_loaded(app, result);
                    self.files_snapshot_applied();
                    self.diff_after_refresh(app);
                }
            }
            Msg::HistoryHead(id, head) => {
                // The head travels by proxy and the result by task completion. The head applies only while
                // its request still runs and no snapshot has landed.
                if self.tasks.snapshot.is_running(id) && self.snapshot.is_none() {
                    self.history_head_loaded(head);
                }
            }
            Msg::CommitPage(id, result) => {
                if self.tasks.page.finish(id) {
                    self.page_loaded(app, result);
                }
            }
            Msg::CommitGraphHint(id, result) => {
                if self.tasks.commit_graph.finish(id) {
                    self.commit_graph_hint_loaded(result);
                }
            }
            Msg::WatchPaths(id, result) => {
                if self.tasks.watch_paths.finish(id) {
                    self.watch_paths_loaded(app, result);
                }
            }
            Msg::CommitFiles(id, result) => {
                if self.tasks.commit_files.finish(id) {
                    self.commit_files_loaded(result);
                }
            }
            Msg::CommitFilesDue => self.commit_files_due(app),
            Msg::FileSelected(file) => self.file_selected(app, file),
            Msg::FileOpened(file) => self.show_file_diff(app, Some(file)),
            Msg::Details(action) => self.details_action(app, action),
            Msg::Composer(action) => self.composer_action(app, action),
            Msg::FileHistoryClick(index) => self.select_file_history(app, index),
            Msg::FileHistoryWheel(delta) => {
                self.focus_changes();
                self.scroll_file_history(app, delta);
            }
            Msg::FileHistory(id, loaded) => {
                if self.tasks.file_history.finish(id) {
                    self.file_history_loaded(app, loaded);
                }
            }
            Msg::Blame(id, result) => {
                if self.tasks.blame.finish(id) {
                    self.blame_loaded(result);
                }
            }
            Msg::DiffInput(event) => self.diff_input(event),
            Msg::Overlay(msg) => self.overlay_msg(app, msg),
            Msg::Sidebar(msg) => self.sidebar_msg(app, msg),
            Msg::Header(msg) => self.header_msg(app, msg),
            Msg::Diff(id, result) => {
                if self.tasks.diff.finish(id) {
                    self.diff_loaded(result);
                }
            }
            Msg::Mutation(id, result) => {
                if self.tasks.mutation.finish(id) {
                    self.mutation_done(app, result);
                }
            }
            Msg::PullRequests(id, list) => {
                if self.tasks.pull_requests.finish(id) {
                    self.pull_requests_loaded(app, list);
                }
            }
            Msg::GraphAvatar(loaded) => self.graph_avatar_loaded(app, loaded),
            Msg::AuthorPhoto(loaded) => self.author_photo_loaded(app, loaded),
            Msg::ProviderBadge(loaded) => self.provider_badge_loaded(app, loaded),
            Msg::PullRequestsDue => self.pull_requests_due(app),
            Msg::SpinnerTick => self.spinner_tick(),
            Msg::NoticeExpired(generation) => self.notice_expired(generation),
            Msg::BackgroundFetch => self.background_fetch(app),
            Msg::ScrollFlush => self.flush_history_scroll(),
            Msg::ScrollSettled => self.history_settled(),
            Msg::Poll => {
                // The periodic refresh waits while the user types.
                if !self.composing() {
                    self.request_refresh(app, true);
                }
            }
            Msg::Watch { generation, event } => self.watch_event(app, generation, event),
        }
        self.settle_history(app);
        self.settle_files(app);
        self.settle_composer(app);
    }

    fn command(&mut self, app: &App, command: Command) {
        match command {
            Command::Quit => {
                self.flush_pending_layout(app);
                app.quit()
            }
            Command::MoveCommit(delta) if self.files.focus == Focus::Changes => {
                self.move_file(app, delta)
            }
            // The diff covers the history pane, and `moveCommit` ignores keys while it is visible.
            Command::MoveCommit(_) if self.diff.is_open() => {}
            Command::MoveCommit(delta) => {
                if !self.scroll_file_history(app, delta) {
                    self.move_commit(delta);
                }
            }
            // With no graph to pan, the arrows step through the files, as in TS.
            Command::ScrollGraph(delta) => {
                if self.files.focus == Focus::Changes || !self.scroll_graph(delta) {
                    self.move_file(app, delta);
                }
            }
            Command::SwitchPane => self.switch_pane(),
            Command::Open => {
                if self.diff.selected_rows.is_empty() {
                    self.files_enter(app);
                } else {
                    self.apply_selected_lines(app, false);
                }
            }
            Command::OpenPalette => self.toggle_palette(app),
            Command::Back => {
                if self.cancel_mutation() {
                    return;
                }
                // `escapeKey` closes an open file history before the line selection and the diff.
                if !self.composer.editing() && self.clear_file_history() {
                    return;
                }
                if !self.composer_escape(app) && !self.diff_escape() {
                    self.escape_details();
                }
            }
            Command::ToggleStaged => self.files_toggle_mode(),
            // `c` clears a branch filter that Enter left applied.
            Command::Compose
                if self.files.focus == Focus::History && !self.sidebar.filter.is_empty() =>
            {
                self.cancel_branch_filter(app)
            }
            Command::Compose => self.focus_composer(),
            Command::FilterBranches => {
                if self.files.focus == Focus::History {
                    self.start_branch_filter(app);
                }
            }
            Command::ToggleLeftPanel => self.toggle_panel_key(true),
            Command::ToggleDetailsPanel => self.toggle_panel_key(false),
            Command::Refresh => self.request_refresh(app, false),
            Command::StageFirstHunk => self.stage_first_hunk(app),
            Command::ToggleDiffView => self.toggle_diff_view(app),
            // Shift+L loads a diff past the limit. TS falls through to the `l` key when there is none to load.
            Command::LoadLargeDiff => {
                if self.diff.is_open() && self.diff.too_large {
                    self.load_diff(app, true);
                } else {
                    self.run_palette_command(app, "repository.pull");
                }
            }
            Command::Fetch => self.run_palette_command(app, "repository.fetch"),
            Command::Pull => self.run_palette_command(app, "repository.pull"),
            Command::Push => self.run_palette_command(app, "repository.push"),
            Command::StageSelected => self.stage_selected_key(app, true),
            Command::UnstageSelected => self.stage_selected_key(app, false),
            Command::StageAll => self.stage_all(app),
            Command::DiscardAll => self.discard_all(app),
        }
    }
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;
