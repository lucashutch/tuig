//! The header: repository tabs, the toolbar and the repository picker. Ports `src/ui/runtime-tabs.ts` (tab
//! switching, opening and closing, drag, the picker), `src/ui/runtime-toolbar.ts`, `runToolbarAction` in
//! `src/ui/runtime-commands.ts` (including Undo), and the session saving of `src/ui/runtime-preferences.ts`.
//!
//! The shell shows one repository at a time. [`HeaderState`] keeps the open tabs. Switching tabs gives the shell a
//! fresh state for the new repository ([`Shell::switch_repository`]) and starts its loads again, which is what the
//! TS tab switch does by resetting the same fields.
//!
//! Differences from the TS app:
//!
//! - A tab does not remember its history position. A switched-to tab starts at its checked-out commit, as a newly
//!   opened tab does in TS.
//! - A click on a picker suggestion picks the row it is on. TS maps the click one row too low.
//! - Directory suggestions are read on the UI thread.
//! - The terminal title is not set.

use crate::screens::footer::NoticeTone;
use crate::services::PullRequestServiceFor;
use crate::shell::{Dirty, GitResult, Inbox, Msg, Shell};
use crate::sync::wire_hover;

use opentui::prelude::*;
use opentui::widget::{Input, View};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use tuig_git::process::GitError;
use tuig_git::repository::{GitRepository, create_git_repository};
use tuig_git::repository_browser::{
    DirectorySuggestion, resolve_repository_path, suggest_directories,
};
use tuig_git::types::{Submodule, UndoPreview, Worktree};
use tuig_ui_model::graph_menu::ConfirmRequest;
use tuig_ui_model::repository_tabs::{
    RepositoryTab, drag_repository_tab, submodule_tab_label, worktree_tab_label,
};
use tuig_ui_model::session_preferences::{
    SessionPreferences, SubmoduleRelation, promote_recent_repository, remove_recent_repository,
    save_session_preferences,
};
use tuig_ui_model::theme::{Theme, one_dark_theme};
use tuig_ui_model::toolbar::{ToolbarAction, toolbar_buttons};
use tuig_widgets::commit_text::short_sha;
use tuig_widgets::diff::effective_diff_view;
use tuig_widgets::header::{HeaderBar, HeaderEvent, HeaderView, SummaryState};
use tuig_widgets::pointer::PointerTracker;
use tuig_widgets::pull_requests::SPINNER_FRAMES;
use tuig_widgets::repository_picker::{PickerEvent, PickerRow, PickerView, RepositoryPicker};

/// Time between busy spinner frames. `BRAILLE_SPINNER_INTERVAL_MS`.
const SPINNER_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
const WAIT_FOR_GIT: &str = "Wait for the current Git operation to finish";

/// What an event of the header asks the shell to do. One variant of [`Msg`].
pub enum HeaderMsg {
    Event(HeaderEvent),
    Picker(PickerEvent),
    /// The path input changed.
    PickerInput,
    /// Enter in the path input.
    PickerSubmit,
    /// A repository finished opening.
    Opened(OpenSource, GitResult<Arc<dyn GitRepository>>),
    UndoPreview(GitResult<UndoPreview>),
    SpinnerTick,
}

/// Why a repository is opening, for the error text and the tab's parent.
pub enum OpenSource {
    Path(String),
    Submodule {
        parent: String,
        submodule: Submodule,
    },
    Worktree(Worktree),
}

#[derive(Clone)]
pub struct Tab {
    pub id: String,
    pub repo: Arc<dyn GitRepository>,
    pub submodule_of: Option<SubmoduleRelation>,
}

pub struct PickerState {
    suggestions: Vec<DirectorySuggestion>,
    index: usize,
    rows: usize,
    left: i64,
    top: i64,
    width: i64,
    height: i64,
}

/// The tabs to start with. See [`Shell::restore_tabs`].
pub struct TabsInit {
    /// Every open repository in tab order, including the one the shell started with.
    pub repositories: Vec<Arc<dyn GitRepository>>,
    pub submodules: BTreeMap<String, SubmoduleRelation>,
    pub recent: Vec<String>,
    /// Where the session is saved. `None` saves nothing.
    pub session_path: Option<PathBuf>,
}

pub struct HeaderState {
    pub tabs: Vec<Tab>,
    pub active: String,
    next_id: usize,
    pub recent: Vec<String>,
    pub(crate) picker: Option<PickerState>,
    session_path: Option<PathBuf>,
    pull_requests_for: Option<PullRequestServiceFor>,
    spinner: Option<TimerId>,
    spinner_frame: usize,
    /// What the widget shows now, to skip a repaint when nothing changed.
    shown: Option<HeaderView>,
}

impl HeaderState {
    pub fn new(
        repo: Arc<dyn GitRepository>,
        pull_requests_for: Option<PullRequestServiceFor>,
    ) -> Self {
        Self {
            tabs: vec![Tab {
                id: "repository-0".to_owned(),
                repo,
                submodule_of: None,
            }],
            active: "repository-0".to_owned(),
            next_id: 1,
            recent: Vec::new(),
            picker: None,
            session_path: None,
            pull_requests_for,
            spinner: None,
            spinner_frame: 0,
            shown: None,
        }
    }

    fn new_id(&mut self) -> String {
        let id = format!("repository-{}", self.next_id);
        self.next_id += 1;
        id
    }

    fn tab_entries(&self) -> Vec<RepositoryTab> {
        self.tabs
            .iter()
            .map(|tab| {
                let root = tab.repo.root();
                let label = match (&tab.submodule_of, tab.repo.main_worktree()) {
                    (Some(parent), _) => Some(submodule_tab_label(root, &parent.root)),
                    (None, Some(main)) => Some(worktree_tab_label(root, main)),
                    (None, None) => None,
                };
                RepositoryTab {
                    id: tab.id.clone(),
                    path: root.to_owned(),
                    label,
                }
            })
            .collect()
    }

    /// Recently opened repositories without a tab. `closedRecentRepositories`.
    fn closed_recent(&self) -> Vec<String> {
        self.recent
            .iter()
            .filter(|path| !self.tabs.iter().any(|tab| tab.repo.root() == path.as_str()))
            .cloned()
            .collect()
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.tabs.iter().position(|tab| tab.id == id)
    }
}

/// The header widgets: the bar over rows 0 to 2, and the picker box and its path input.
pub struct HeaderWidgets {
    pub bar: Custom<HeaderBar>,
    picker: Custom<RepositoryPicker>,
    picker_input: Input,
}

impl HeaderWidgets {
    pub fn new(app: &App, theme: &Theme, inbox: &Rc<Inbox>, pointer: &PointerTracker) -> Self {
        let mut bar = HeaderBar::new(theme.clone());
        bar.set_pointer_tracker(pointer.clone());
        {
            let inbox = inbox.clone();
            bar.on_event(move |cx, event| {
                inbox.post(cx.app(), Msg::Header(HeaderMsg::Event(event)));
            });
        }
        let mut picker = RepositoryPicker::new(theme.clone());
        {
            let inbox = inbox.clone();
            picker.on_event(move |cx, event| {
                inbox.post(cx.app(), Msg::Header(HeaderMsg::Picker(event)));
            });
        }
        let input = Input::new(app)
            .absolute()
            .z_index(92)
            .height(1)
            .placeholder("Path from current directory")
            // The TS golden (`golden/repo-tabs/picker.snap`) shows fg=5c6370.
            .placeholder_color(Color::rgb(0x5c, 0x63, 0x70))
            .colors(color(theme.text), color(theme.selected))
            .focused_colors(color(theme.text), color(theme.selected))
            .visible(false);
        // The arrows move the suggestion selection. The input has one line.
        input.unbind("up");
        input.unbind("down");
        {
            let inbox = inbox.clone();
            input.on_change(move |cx, _| {
                inbox.post(cx.app(), Msg::Header(HeaderMsg::PickerInput));
            });
        }
        {
            let inbox = inbox.clone();
            input.on_submit(move |cx, _| {
                inbox.post(cx.app(), Msg::Header(HeaderMsg::PickerSubmit));
            });
        }
        let bar = Custom::new(app, bar).absolute();
        wire_hover(&bar, |bar, entered| {
            if entered {
                bar.pointer_entered();
            } else {
                bar.pointer_left();
            }
        });
        Self {
            bar,
            picker: Custom::new(app, picker)
                .absolute()
                .z_index(90)
                .visible(false),
            picker_input: input,
        }
    }

    pub fn attach(&self, root: &View) {
        root.add(&self.bar)
            .add(&self.picker)
            .add(&self.picker_input);
    }

    pub fn place(&self, width: i64, height: i64) {
        crate::sync::place(&self.bar, 0, 0, width, height);
    }
}

fn color(color: tuig_ui_model::color::Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

fn folder_name(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("repository")
        .to_owned()
}

impl Shell {
    /// Gives the shell the repositories of the saved session. The shell started with the active one. Call it once,
    /// before the first message runs.
    pub fn restore_tabs(&mut self, init: TabsInit) {
        let active_root = self.repo.root().to_owned();
        let header = &mut self.header;
        header.tabs = init
            .repositories
            .into_iter()
            .enumerate()
            .map(|(index, repo)| Tab {
                id: format!("repository-{index}"),
                submodule_of: init.submodules.get(repo.root()).cloned(),
                repo,
            })
            .collect();
        header.next_id = header.tabs.len();
        if let Some(active) = header
            .tabs
            .iter()
            .find(|tab| tab.repo.root() == active_root)
        {
            header.active = active.id.clone();
        } else if let Some(first) = header.tabs.first() {
            // The shell's repository must be a tab. Keep the strip consistent if the caller forgot it.
            header.active = first.id.clone();
        }
        header.recent = promote_recent_repository(&init.recent, &active_root);
        header.session_path = init.session_path;
    }

    fn persist_session(&self) {
        let Some(path) = &self.header.session_path else {
            return;
        };
        let submodules: BTreeMap<String, SubmoduleRelation> = self
            .header
            .tabs
            .iter()
            .filter_map(|tab| Some((tab.repo.root().to_owned(), tab.submodule_of.clone()?)))
            .collect();
        let preferences = SessionPreferences {
            repositories: self
                .header
                .tabs
                .iter()
                .map(|tab| tab.repo.root().to_owned())
                .collect(),
            active_repository: Some(self.repo.root().to_owned()),
            submodules: Some(submodules),
            recent_repositories: Some(self.header.recent.clone()),
        };
        // A session that cannot be saved must not stop the app.
        let _ = save_session_preferences(&preferences, path);
    }

    fn promote_recent(&mut self, root: &str) {
        self.header.recent = promote_recent_repository(&self.header.recent, root);
    }

    pub(crate) fn header_msg(&mut self, app: &App, msg: HeaderMsg) {
        match msg {
            HeaderMsg::Event(event) => self.header_event(app, event),
            HeaderMsg::Picker(PickerEvent::Choose(row)) => self.choose_suggestion(app, row),
            HeaderMsg::PickerInput => {
                if let Some(picker) = &mut self.header.picker {
                    picker.index = 0;
                    self.update_suggestions();
                }
            }
            HeaderMsg::PickerSubmit => {
                if self.header.picker.is_some() {
                    let typed = self.widgets.header.picker_input.value();
                    let recent = if typed.trim().is_empty() {
                        let index = self.header.picker.as_ref().map_or(0, |picker| picker.index);
                        self.header.closed_recent().get(index).cloned()
                    } else {
                        None
                    };
                    self.open_repository_path(app, recent);
                }
            }
            HeaderMsg::Opened(source, result) => self.repository_opened(app, source, result),
            HeaderMsg::UndoPreview(result) => self.undo_previewed(result),
            HeaderMsg::SpinnerTick => {
                self.header.spinner_frame = (self.header.spinner_frame + 1) % SPINNER_FRAMES.len();
            }
        }
    }

    fn header_event(&mut self, app: &App, event: HeaderEvent) {
        match event {
            HeaderEvent::TabSelect(id) => self.activate_tab(app, &id),
            HeaderEvent::TabClose(id) | HeaderEvent::TabMiddleClose(id) => self.close_tab(app, &id),
            HeaderEvent::TabOpen => self.show_repository_picker(app),
            HeaderEvent::TabDrag { id, x } => self.drag_tab(&id, x),
            HeaderEvent::Toolbar(action) => self.run_toolbar_action(app, action),
            HeaderEvent::ToggleAvatars => self.set_avatars_enabled(!self.avatars.enabled),
            HeaderEvent::ToggleDiffView => self.toggle_diff_view(),
        }
    }

    /// `runToolbarAction`. The remote and stash actions are the palette's.
    pub(crate) fn run_toolbar_action(&mut self, app: &App, action: ToolbarAction) {
        let command = match action {
            ToolbarAction::Refresh => "repository.refresh",
            ToolbarAction::Fetch => "repository.fetch",
            ToolbarAction::Pull => "repository.pull",
            ToolbarAction::Push => "repository.push",
            ToolbarAction::Stash => "repository.stash",
            ToolbarAction::Pop => "repository.pop-stash",
            ToolbarAction::Undo => return self.start_undo(app),
        };
        self.run_palette_command(app, command);
    }

    /// Reads the undo preview, then asks for confirmation. The check holds the mutation slot, so nothing else
    /// starts meanwhile.
    fn start_undo(&mut self, app: &App) {
        if let Some(running) = &self.diff.mutation {
            self.notify_error(format!("{running} is still running"));
            return;
        }
        let label = "Checking undo…";
        self.diff.mutation = Some(label.to_owned());
        self.notify_tone(NoticeTone::Busy, label);
        let repo = self.repo.clone();
        let inbox = self.inbox.clone();
        app.spawn(
            async move { repo.get_undo_preview().await },
            move |cx, result| inbox.post(cx.app(), Msg::Header(HeaderMsg::UndoPreview(result))),
        );
    }

    fn undo_previewed(&mut self, result: GitResult<UndoPreview>) {
        self.diff.mutation = None;
        let preview = match result {
            Ok(preview) => preview,
            Err(error) => return self.notify_error(error.to_string()),
        };
        self.notice = None;
        let repo = self.repo.clone();
        self.confirm_then(
            ConfirmRequest {
                title: "Undo local history".to_owned(),
                lines: vec![
                    format!("Action: {}", preview.action),
                    format!("Branch: {}", preview.branch),
                    format!("Move to {}.", short_sha(&preview.target)),
                    "This changes local history only.".to_owned(),
                    "It does not undo remote changes or recover discarded edits.".to_owned(),
                    "Do not run other Git commands during Undo.".to_owned(),
                ],
                confirm_label: "Undo".to_owned(),
                destructive: true,
            },
            move |shell, app| {
                shell.perform(app, "Undoing…", async move { repo.undo(&preview).await })
            },
        );
    }

    // Tabs.

    pub(crate) fn activate_tab(&mut self, app: &App, id: &str) {
        let Some(tab) = self.header.tabs.iter().find(|tab| tab.id == id).cloned() else {
            return;
        };
        if id == self.header.active {
            return;
        }
        if self.diff.mutation.is_some() {
            return self.notify(WAIT_FOR_GIT);
        }
        self.close_repository_picker(app);
        self.header.active = tab.id.clone();
        self.switch_repository(app, tab.repo.clone());
        self.persist_session();
    }

    pub(crate) fn activate_relative_tab(&mut self, app: &App, delta: isize) {
        let count = self.header.tabs.len() as isize;
        let Some(index) = self.header.position(&self.header.active) else {
            return;
        };
        let next = (index as isize + delta).rem_euclid(count) as usize;
        let id = self.header.tabs[next].id.clone();
        self.activate_tab(app, &id);
    }

    pub(crate) fn close_tab(&mut self, app: &App, id: &str) {
        let Some(index) = self.header.position(id) else {
            return;
        };
        if id == self.header.active && self.diff.mutation.is_some() {
            return self.notify(WAIT_FOR_GIT);
        }
        if self.header.tabs.len() == 1 {
            return app.quit();
        }
        let was_active = id == self.header.active;
        let removed = self.header.tabs.remove(index);
        let repo = removed.repo;
        app.runtime().spawn(async move { repo.dispose().await });
        if was_active {
            let next = self.header.tabs[index.min(self.header.tabs.len() - 1)].clone();
            self.close_repository_picker(app);
            self.header.active = next.id;
            self.switch_repository(app, next.repo);
        }
        self.persist_session();
    }

    fn drag_tab(&mut self, id: &str, x: usize) {
        let width = usize::from(self.layout.width).max(1);
        let entries = self.header.tab_entries();
        let Some(order) =
            drag_repository_tab(&entries, id, x, Some(self.header.active.as_str()), width)
        else {
            return;
        };
        let mut tabs = std::mem::take(&mut self.header.tabs);
        self.header.tabs = order
            .iter()
            .filter_map(|id| {
                tabs.iter()
                    .position(|tab| &tab.id == id)
                    .map(|at| tabs.remove(at))
            })
            .collect();
        self.header.tabs.extend(tabs);
        self.persist_session();
    }

    /// Ctrl+T, Ctrl+W, Ctrl+Tab and the picker's keys. Returns true when the key is used up.
    pub(crate) fn header_key(&mut self, app: &App, key: &KeyEvent) -> bool {
        use opentui::input::KeyEventKind;
        if key.kind == KeyEventKind::Release {
            return self.header.picker.is_some();
        }
        if self.header.picker.is_some() {
            self.picker_key(app, key);
            return true;
        }
        if key.matches("ctrl+t") {
            self.show_repository_picker(app);
        } else if key.matches("ctrl+w") {
            let active = self.header.active.clone();
            self.close_tab(app, &active);
        } else if key.matches("ctrl+shift+tab") {
            self.activate_relative_tab(app, -1);
        } else if key.matches("ctrl+tab") {
            self.activate_relative_tab(app, 1);
        } else {
            return false;
        }
        true
    }

    /// Opens another repository in a tab, or shows its tab when it is open. `openSubmodule`.
    pub(crate) fn open_submodule(&mut self, app: &App, submodule: Submodule) {
        let parent = self.repo.root().to_owned();
        let path = Path::new(&parent).join(&submodule.path);
        self.open_repository(app, path, OpenSource::Submodule { parent, submodule });
    }

    /// `openWorktree`.
    pub(crate) fn open_worktree(&mut self, app: &App, worktree: Worktree) {
        let path = PathBuf::from(&worktree.path);
        self.open_repository(app, path, OpenSource::Worktree(worktree));
    }

    fn open_repository(&mut self, app: &App, path: PathBuf, source: OpenSource) {
        let inbox = self.inbox.clone();
        app.spawn(
            async move {
                create_git_repository(path)
                    .await
                    .map(|repo| Arc::new(repo) as Arc<dyn GitRepository>)
            },
            move |cx, result| {
                inbox.post(cx.app(), Msg::Header(HeaderMsg::Opened(source, result)));
            },
        );
    }

    fn repository_opened(
        &mut self,
        app: &App,
        source: OpenSource,
        result: GitResult<Arc<dyn GitRepository>>,
    ) {
        let repository = match result {
            Ok(repository) => repository,
            Err(error) => {
                let text = match (&source, &error) {
                    (OpenSource::Path(path), GitError::NotRepository(_)) => {
                        format!("Not a Git repository: {path}")
                    }
                    (OpenSource::Submodule { submodule, .. }, _)
                        if submodule.state == tuig_git::types::SubmoduleState::Uninitialized =>
                    {
                        format!("Initialize {} before opening it", submodule.path)
                    }
                    (OpenSource::Worktree(worktree), _) if worktree.prunable.is_some() => {
                        format!("Worktree {} no longer exists", worktree.path)
                    }
                    _ => error.to_string(),
                };
                return self.notify_error(text);
            }
        };
        let root = repository.root().to_owned();
        let existing = self
            .header
            .tabs
            .iter_mut()
            .find(|tab| tab.repo.root() == root);
        let id = match existing {
            Some(tab) => {
                if let OpenSource::Submodule { parent, submodule } = &source
                    && tab.submodule_of.is_none()
                {
                    tab.submodule_of = Some(SubmoduleRelation {
                        root: parent.clone(),
                        path: submodule.path.clone(),
                    });
                }
                let id = tab.id.clone();
                app.runtime()
                    .spawn(async move { repository.dispose().await });
                id
            }
            None => {
                let id = self.header.new_id();
                let submodule_of = match &source {
                    OpenSource::Submodule { parent, submodule } => Some(SubmoduleRelation {
                        root: parent.clone(),
                        path: submodule.path.clone(),
                    }),
                    _ => None,
                };
                self.header.tabs.push(Tab {
                    id: id.clone(),
                    repo: repository,
                    submodule_of,
                });
                id
            }
        };
        self.activate_tab(app, &id);
        // The picker closes on success even when the tab was already active.
        self.close_repository_picker(app);
        if matches!(source, OpenSource::Path(_)) {
            self.promote_recent(&root);
        }
        self.persist_session();
    }

    // The picker.

    pub(crate) fn show_repository_picker(&mut self, app: &App) {
        self.close_popup(app);
        let (columns, rows) = (i64::from(self.layout.width), i64::from(self.layout.height));
        let width = (columns - 4).clamp(30, 70);
        let top = (rows - 10).clamp(1, 4);
        let height = (rows - top - 1).clamp(6, 12);
        if self.header.picker.is_none() {
            self.remember_focus(app);
        }
        self.header.picker = Some(PickerState {
            suggestions: Vec::new(),
            index: 0,
            rows: (height - 5).max(1) as usize,
            left: ((columns - width) / 2).max(0),
            top,
            width,
            height,
        });
        self.widgets.header.picker_input.set_value("");
        self.update_suggestions();
        self.widgets.header.picker_input.visible(true);
        self.widgets.header.picker_input.focus();
    }

    pub(crate) fn close_repository_picker(&mut self, app: &App) {
        if self.header.picker.take().is_none() {
            return;
        }
        self.widgets.header.picker_input.visible(false);
        self.restore_focus(app);
        self.dirty |= Dirty::LAYOUT;
    }

    fn update_suggestions(&mut self) {
        let typed = self.widgets.header.picker_input.value();
        let suggestions = if typed.trim().is_empty() {
            Vec::new()
        } else {
            let cwd = std::env::current_dir().unwrap_or_default();
            suggest_directories(&typed, &cwd)
        };
        let Some(picker) = &mut self.header.picker else {
            return;
        };
        picker.index = picker.index.min(suggestions.len().saturating_sub(1));
        picker.suggestions = suggestions;
    }

    /// The rows on screen and the index of the first one. `paintRepositorySuggestions`.
    fn picker_window(&self) -> (bool, Vec<String>, usize, usize) {
        let Some(picker) = &self.header.picker else {
            return (false, Vec::new(), 0, 0);
        };
        let recent = self.widgets.header.picker_input.value().trim().is_empty();
        let entries: Vec<String> = if recent {
            self.header.closed_recent()
        } else {
            picker
                .suggestions
                .iter()
                .map(|entry| format!("{}/", entry.name))
                .collect()
        };
        let count = picker.rows.saturating_sub(usize::from(recent)).max(1);
        let start = (picker.index + 1)
            .saturating_sub(count)
            .min(entries.len().saturating_sub(count));
        (recent, entries, start, count)
    }

    fn picker_key(&mut self, app: &App, key: &KeyEvent) {
        if key.matches("esc") || key.matches("escape") {
            return self.close_repository_picker(app);
        }
        let (recent, entries, _, _) = self.picker_window();
        if key.matches("up") || key.matches("down") {
            let delta: isize = if key.matches("up") { -1 } else { 1 };
            if let Some(picker) = &mut self.header.picker {
                let last = entries.len().saturating_sub(1) as isize;
                picker.index = (picker.index as isize + delta).clamp(0, last) as usize;
            }
        } else if recent && (key.matches("delete") || key.matches("backspace")) {
            let index = self.header.picker.as_ref().map_or(0, |picker| picker.index);
            if let Some(selected) = entries.get(index) {
                self.header.recent = remove_recent_repository(&self.header.recent, selected);
                let left = self.header.closed_recent().len();
                if let Some(picker) = &mut self.header.picker {
                    picker.index = picker.index.min(left.saturating_sub(1));
                }
                self.persist_session();
            }
        } else if key.matches("tab") {
            self.complete_suggestion(recent, &entries);
        }
    }

    /// Tab: the selected recent path or the selected folder goes into the input. `completeRepositorySuggestion`.
    fn complete_suggestion(&mut self, recent: bool, entries: &[String]) {
        let Some(picker) = &mut self.header.picker else {
            return;
        };
        if recent {
            if let Some(path) = entries.get(picker.index) {
                self.widgets.header.picker_input.set_value(path);
                self.update_suggestions();
            }
            return;
        }
        let Some(suggestion) = picker.suggestions.get(picker.index) else {
            return;
        };
        let value = format!("{}/", suggestion.path.display());
        picker.index = 0;
        self.widgets.header.picker_input.set_value(value);
        self.update_suggestions();
    }

    /// A click on suggestion `row`. A recent path opens. A folder goes into the input. `chooseRepositorySuggestion`.
    fn choose_suggestion(&mut self, app: &App, row: usize) {
        let (recent, entries, start, _) = self.picker_window();
        let Some(entry) = entries.get(start + row) else {
            return;
        };
        if recent {
            let path = entry.clone();
            return self.open_repository_path(app, Some(path));
        }
        let Some(picker) = &mut self.header.picker else {
            return;
        };
        let Some(suggestion) = picker.suggestions.get(start + row) else {
            return;
        };
        let value = format!("{}/", suggestion.path.display());
        picker.index = 0;
        self.widgets.header.picker_input.set_value(value);
        self.update_suggestions();
        self.widgets.header.picker_input.focus();
    }

    /// Opens the typed path, the selected recent repository, or the current directory when nothing is typed.
    pub(crate) fn open_repository_path(&mut self, app: &App, selected_recent: Option<String>) {
        if self.diff.mutation.is_some() {
            return self.notify(WAIT_FOR_GIT);
        }
        let typed = selected_recent.unwrap_or_else(|| {
            let typed = self.widgets.header.picker_input.value();
            let typed = typed.trim();
            if typed.is_empty() {
                std::env::current_dir()
                    .map(|cwd| cwd.to_string_lossy().into_owned())
                    .unwrap_or_default()
            } else {
                typed.to_owned()
            }
        });
        let cwd = std::env::current_dir().unwrap_or_default();
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let path = resolve_repository_path(&typed, &cwd, &home);
        let label = path.to_string_lossy().into_owned();
        self.open_repository(app, path, OpenSource::Path(label));
    }

    // Switching.

    /// Shows `repo` in place of the current repository: drops everything loaded for the old one and starts the
    /// loads for the new one. The caller has checked that no mutation runs. `activateRepositoryTab`.
    fn switch_repository(&mut self, app: &App, repo: Arc<dyn GitRepository>) {
        self.close_popup(app);
        if self.overlay.palette.is_some() {
            self.close_palette(app, false);
        }
        self.tasks.cancel_loads();
        // The watcher events of the old repository carry the old generation.
        self.refresh.watcher = None;
        self.refresh.generation += 1;
        if let Some(timer) = self.refresh.poll.take() {
            app.cancel_timer(timer);
        }
        self.refresh.pending_change = None;
        self.refresh.pending_refresh = false;
        if let Some(timer) = self.pr.refresh_timer.take() {
            app.cancel_timer(timer);
        }
        if let Some(timer) = self.pr.spinner_timer.take() {
            app.cancel_timer(timer);
        }
        let service = self
            .header
            .pull_requests_for
            .filter(|_| self.pr.service.is_some())
            .map(|build| build(repo.root()));
        let opener = self.pr.opener.clone();
        self.pr = crate::screens::pull_requests::PullRequestsState::new(service, opener);

        let side_by_side = self.diff.side_by_side;
        self.diff = crate::screens::diff::DiffState::new();
        self.diff.side_by_side = side_by_side;
        self.snapshot = None;
        self.history = crate::screens::history::HistoryState::new(&one_dark_theme());
        self.files = crate::screens::files::FilesState::new();
        self.details = Default::default();
        self.commands = Default::default();
        self.composer = Default::default();
        self.widgets.composer.summary.set_value("");
        self.widgets.composer.body.set_text("");
        self.clear_graph_avatars();
        self.notice = None;
        self.widgets.history.focus();

        self.repo = repo;
        self.dirty = Dirty::all();
        self.start_snapshot(app);
        self.start_watch_paths(app);
        self.start_pull_requests(app);
    }

    // Painting.

    /// Pushes the header state into the widgets. Runs after every message.
    pub(crate) fn sync_header(&mut self, app: &App) {
        self.sync_spinner_for_busy(app);
        let snapshot = self.snapshot.as_ref();
        let busy = self.busy_label().map(|label| {
            format!(
                "{} {label}",
                SPINNER_FRAMES[self.header.spinner_frame % SPINNER_FRAMES.len()]
            )
        });
        let diff_toggle = self.diff.is_open().then(|| {
            let preferred = self.diff.side_by_side;
            let split = effective_diff_view(preferred, self.layout.panes.history_content_width)
                == tuig_widgets::diff::DiffView::Split;
            let label = match (preferred, split) {
                (false, _) => "Inline",
                (true, true) => "Side by side",
                (true, false) => "Split (narrow)",
            };
            format!("{} {label}", if preferred { "■" } else { "□" })
        });
        let view = HeaderView {
            tabs: self.header.tab_entries(),
            active_tab: Some(self.header.active.clone()),
            name: folder_name(self.repo.root()),
            summary: snapshot.map(|snapshot| SummaryState {
                branch: snapshot.branch.clone(),
                ahead: snapshot.ahead,
                behind: snapshot.behind,
                has_upstream: snapshot.upstream.is_some(),
                changed: snapshot.files.len(),
            }),
            buttons: toolbar_buttons(snapshot),
            busy,
            avatars_enabled: self.avatars.enabled,
            diff_toggle,
        };
        if self.header.shown.as_ref() != Some(&view) {
            self.header.shown = Some(view.clone());
            self.widgets.header.bar.update(|bar| bar.set_view(view));
        }
        self.sync_picker();
    }

    /// The toolbar's busy text: a busy notice, else the running diff mutation. `busyLabel` in TS.
    fn busy_label(&self) -> Option<String> {
        self.busy_notice()
            .map(str::to_owned)
            .or_else(|| self.diff.mutation.clone())
    }

    fn sync_spinner_for_busy(&mut self, app: &App) {
        let busy = self.busy_label().is_some();
        match (busy, self.header.spinner) {
            (true, None) => {
                self.header.spinner_frame = 0;
                let inbox = self.inbox.clone();
                self.header.spinner = Some(app.set_interval(SPINNER_INTERVAL, move |cx| {
                    inbox.post(cx.app(), Msg::Header(HeaderMsg::SpinnerTick))
                }));
            }
            (false, Some(timer)) => {
                app.cancel_timer(timer);
                self.header.spinner = None;
            }
            _ => {}
        }
    }

    fn sync_picker(&mut self) {
        let widgets = &self.widgets.header;
        let Some(picker) = &self.header.picker else {
            let _ = widgets.picker.visible(false);
            return;
        };
        let (left, top, width, height) = (picker.left, picker.top, picker.width, picker.height);
        let (recent, entries, start, count) = self.picker_window();
        let index = picker.index;
        let rows: Vec<PickerRow> = entries
            .iter()
            .enumerate()
            .skip(start)
            .take(count)
            .map(|(at, text)| PickerRow {
                text: text.clone(),
                selected: at == index,
            })
            .collect();
        let view = PickerView {
            heading: recent.then(|| "Recently opened (closed tabs)".to_owned()),
            rows,
            empty: if recent {
                "  No recently closed repositories"
            } else {
                "  No matching folders"
            }
            .to_owned(),
        };
        crate::sync::place(&widgets.picker, left, top, width, height);
        let _ = widgets.picker.visible(true);
        widgets.picker.update(|picker| picker.set_view(view));
        crate::sync::place(
            &widgets.picker_input,
            left + 2,
            top + 2,
            (width - 4).max(8),
            1,
        );
    }
}

#[cfg(test)]
#[path = "header_tests.rs"]
mod tests;
