//! The changed-files pane. Ports `src/ui/runtime-files.ts`, the file parts of `src/ui/runtime-paint.ts`
//! (`paintFiles`, `paintSection`), `openCommit` in `src/ui/runtime-data.ts`, and the pane geometry in
//! `layoutChanges` (`src/ui/runtime-layout.ts`).
//!
//! The pane shows the working changes (unstaged and staged sections) or the files of one commit. The view follows
//! TS: a click or Enter on a commit opens it, and a click on the working row or Esc returns to the working changes.
//! The selection is a path. It survives refreshes and view changes, and moves to the nearest file when its file
//! is gone.
//!
//! Other panes read `Shell::files.selected` and react to `Msg::FileSelected` and `Msg::FileOpened`.

use crate::screens::commands::FileAction;
use crate::screens::popup::OverlayMsg;
use crate::selected_file::{FileSource, SelectedFile};
use crate::shell::{Dirty, GitResult, Inbox, Msg, PANE_TOP, Shell};
use opentui::prelude::*;
use opentui::widget::View;
use std::collections::HashSet;
use std::rc::Rc;
use std::time::Duration;
use tuig_git::types::ChangedFile;
use tuig_ui_model::changes_layout::{
    ChangeSectionsInput, file_viewport_size, layout_change_sections,
};
use tuig_ui_model::color::Rgba;
use tuig_ui_model::file_tree::{
    FileRowAction, FileSection, FileTreeDirectory, FileTreeNode, build_file_tree,
    expand_new_directories, flatten_visible, toggle_expansion,
};
use tuig_ui_model::history_viewport::HistorySelection;
use tuig_ui_model::runtime_layout::{
    ChangesGeometry, ChangesInputs, ChangesLayout, ComposerLayout, View as ChangesView,
    WorkingChangesGeometry, layout_changes,
};
use tuig_ui_model::text_width::string_width;
use tuig_ui_model::theme::Theme;
use tuig_widgets::files::{
    ActionButton, FileList, FileListData, FileListEvent, FileRow, ListKind, ListStatus, SplitBar,
    SplitEvent,
};

/// Wait before a commit's files load after the selection moves. 0 until the parity harness waits for loads
/// (`rust/docs/app-shell.md`, "Selection debounce").
pub const COMMIT_FILES_DEBOUNCE: Duration = Duration::ZERO;

pub const DISCARD_ALL_LABEL: &str = " ✖  Discard all ";
pub const STAGE_ALL_LABEL: &str = " ✚  Stage all ";
pub const UNSTAGE_ALL_LABEL: &str = " −  Unstage all ";

/// Which pane has keyboard focus. `focus` in `Runtime`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Focus {
    #[default]
    History,
    Changes,
}

/// What the pane lists. `view` in `Runtime`, where `history` is the working changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Contents {
    #[default]
    Working,
    Commit,
}

/// The pane-wide buttons: Discard all, Stage all, Unstage all. The staging code handles them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangesAction {
    Discard,
    Stage,
    Unstage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Split {
    /// Between the unstaged and staged lists.
    Files,
    /// Between the staged list and the composer.
    Composer,
}

#[derive(Default)]
struct TreeCache {
    files: Option<Rc<[ChangedFile]>>,
    tree: FileTreeDirectory,
    rows: Vec<FileRow>,
    /// The expansion version `rows` was flattened for.
    rows_version: Option<u64>,
}

fn flat_rows(tree: &FileTreeDirectory, expanded: &HashSet<String>) -> Vec<FileRow> {
    flatten_visible(tree, expanded)
        .into_iter()
        .map(|row| match row.node {
            FileTreeNode::File(file) => FileRow {
                name: file.name.clone(),
                path: file.file.path.clone(),
                depth: row.depth,
                directory: false,
                expanded: false,
                state: Some(file.file.state),
            },
            FileTreeNode::Directory(dir) => FileRow {
                name: dir.name.clone(),
                path: dir.path.clone(),
                depth: row.depth,
                directory: true,
                expanded: expanded.contains(&dir.path),
                state: dir.status,
            },
        })
        .collect()
}

/// The commit whose files the pane shows, and their load state.
#[derive(Default)]
pub struct CommitFiles {
    /// The commit the pane wants. `None` in the working view.
    pub sha: Option<String>,
    pub files: Option<Rc<[ChangedFile]>>,
    pub error: Option<String>,
    requested: bool,
}

pub struct FilesState {
    pub focus: Focus,
    pub contents: Contents,
    /// The working section the selection and keys act on. `mode` in `Runtime`.
    pub mode: FileSection,
    /// The highlighted file. Other panes read this.
    pub selected: Option<SelectedFile>,
    pub commit: CommitFiles,
    /// Unstaged and staged files of the snapshot. Rebuilt only when the files change, so the tree caches hold.
    unstaged: Rc<[ChangedFile]>,
    staged: Rc<[ChangedFile]>,
    selected_path: Option<String>,
    /// Position of the selected file among the visible files, for choosing a neighbor when its file is gone.
    last_index: usize,
    /// Collapsed sections, unstaged first. Not used in the commit view.
    collapsed: [bool; 2],
    /// First visible row per list: unstaged, staged, commit.
    start: [usize; 3],
    /// Shared by every list, as in TS. A directory is expanded when first seen.
    expanded: HashSet<String>,
    seen: HashSet<String>,
    /// Bumped when `expanded` changes. Flattened rows are valid for one version.
    expansion_version: u64,
    caches: [TreeCache; 3],
    pub preferred_unstaged_height: Option<i64>,
    pub preferred_composer_height: Option<i64>,
    /// The selection last sent in `Msg::FileSelected`.
    announced: Option<SelectedFile>,
    pub debounce: Duration,
    timer: Option<TimerId>,
}

impl Default for FilesState {
    fn default() -> Self {
        Self::new()
    }
}

fn slot(kind: ListKind) -> usize {
    match kind {
        ListKind::Unstaged => 0,
        ListKind::Staged => 1,
        ListKind::Commit => 2,
    }
}

impl FilesState {
    pub fn new() -> Self {
        Self {
            focus: Focus::History,
            contents: Contents::Working,
            mode: FileSection::Unstaged,
            selected: None,
            commit: CommitFiles::default(),
            unstaged: Rc::from(Vec::new()),
            staged: Rc::from(Vec::new()),
            selected_path: None,
            last_index: 0,
            collapsed: [false; 2],
            start: [0; 3],
            expanded: HashSet::new(),
            seen: HashSet::new(),
            expansion_version: 0,
            caches: Default::default(),
            preferred_unstaged_height: None,
            preferred_composer_height: None,
            announced: None,
            debounce: COMMIT_FILES_DEBOUNCE,
            timer: None,
        }
    }

    /// Files in the staged list. The commit button counts them.
    pub fn staged_count(&self) -> usize {
        self.staged.len()
    }

    /// The list the keys and the selection act on.
    pub fn active(&self) -> ListKind {
        match (self.contents, self.mode) {
            (Contents::Commit, _) => ListKind::Commit,
            (Contents::Working, FileSection::Unstaged) => ListKind::Unstaged,
            (Contents::Working, FileSection::Staged) => ListKind::Staged,
        }
    }

    /// The list a widget of `section` shows: the unstaged widget shows the commit's files in the commit view.
    pub(crate) fn kind_of(&self, section: ListKind) -> ListKind {
        match (self.contents, section) {
            (Contents::Commit, _) => ListKind::Commit,
            (_, section) => section,
        }
    }

    fn files_of(&self, kind: ListKind) -> Rc<[ChangedFile]> {
        match kind {
            ListKind::Unstaged => self.unstaged.clone(),
            ListKind::Staged => self.staged.clone(),
            ListKind::Commit => self
                .commit
                .files
                .clone()
                .unwrap_or_else(|| Rc::from(Vec::new())),
        }
    }

    /// The flattened visible rows of a list, from the cache when neither the files nor the expansion changed.
    pub fn rows(&mut self, kind: ListKind) -> &[FileRow] {
        let files = self.files_of(kind);
        let Self {
            caches,
            expanded,
            seen,
            expansion_version,
            ..
        } = self;
        let cache = &mut caches[slot(kind)];
        if !cache
            .files
            .as_ref()
            .is_some_and(|cached| Rc::ptr_eq(cached, &files))
        {
            cache.tree = build_file_tree(&files);
            cache.files = Some(files);
            let before = expanded.len();
            expand_new_directories(&cache.tree, expanded, seen);
            if expanded.len() != before {
                *expansion_version += 1;
            }
            cache.rows_version = None;
        }
        if cache.rows_version != Some(*expansion_version) {
            cache.rows = flat_rows(&cache.tree, expanded);
            cache.rows_version = Some(*expansion_version);
        }
        &cache.rows
    }

    /// The files behind row `row` of the list `section` shows: the file itself, or every file under a directory
    /// row. The flag tells whether the row is a directory.
    pub(crate) fn row_files(
        &mut self,
        section: ListKind,
        row: usize,
    ) -> Option<(Vec<ChangedFile>, bool)> {
        let kind = self.kind_of(section);
        let entry = self.rows(kind).get(row)?.clone();
        let files = self.files_of(kind);
        if !entry.directory {
            let file = files.iter().find(|file| file.path == entry.path)?;
            return Some((vec![file.clone()], false));
        }
        let prefix = format!("{}/", entry.path);
        let under = files
            .iter()
            .filter(|file| file.path.starts_with(&prefix))
            .cloned()
            .collect();
        Some((under, true))
    }

    fn toggle_directory(&mut self, path: &str) {
        self.expanded = toggle_expansion(&self.expanded, path);
        self.expansion_version += 1;
    }

    /// Replaces the working lists when the snapshot's files differ.
    fn set_working_files(&mut self, files: &[ChangedFile]) {
        let unstaged: Vec<ChangedFile> = files.iter().filter(|f| f.unstaged).cloned().collect();
        let staged: Vec<ChangedFile> = files.iter().filter(|f| f.staged).cloned().collect();
        if *self.unstaged != *unstaged {
            self.unstaged = unstaged.into();
        }
        if *self.staged != *staged {
            self.staged = staged.into();
        }
    }

    /// Keeps the selection on a file of the active list. A missing path moves to the file at the old position.
    fn resolve_selection(&mut self) {
        let kind = self.active();
        let files = self.files_of(kind);
        if files.is_empty() {
            self.selected_path = None;
            return;
        }
        let visible: Vec<String> = self
            .rows(kind)
            .iter()
            .filter(|row| !row.directory)
            .map(|row| row.path.clone())
            .collect();
        let present = |path: &String| files.iter().any(|file| file.path == *path);
        match self.selected_path.as_ref().filter(|path| present(path)) {
            Some(path) => {
                if let Some(at) = visible.iter().position(|visible| visible == path) {
                    self.last_index = at;
                }
            }
            None => {
                let at = self.last_index.min(visible.len().saturating_sub(1));
                self.selected_path = visible
                    .get(at)
                    .cloned()
                    .or_else(|| files.first().map(|file| file.path.clone()));
                self.last_index = at;
            }
        }
    }

    fn compute_selected(&self) -> Option<SelectedFile> {
        let path = self.selected_path.clone()?;
        let source = match self.contents {
            Contents::Commit => {
                self.commit.files.as_ref()?;
                FileSource::Commit(self.commit.sha.clone()?)
            }
            Contents::Working => match self.mode {
                FileSection::Unstaged => FileSource::WorkingUnstaged,
                FileSection::Staged => FileSource::WorkingStaged,
            },
        };
        // A rename or copy needs its previous path to load the diff.
        let original_path = self
            .files_of(self.active())
            .iter()
            .find(|file| file.path == path)
            .and_then(|file| file.original_path.clone());
        Some(SelectedFile {
            path,
            original_path,
            source,
        })
    }
}

/// Pane-relative geometry of the file widgets, from `layout_changes`.
struct Place {
    changes: ChangesLayout,
    /// The two lists as (label row, list rows), `None` when hidden.
    unstaged: Option<(i64, i64)>,
    staged: Option<(i64, i64)>,
    discard_left: i64,
    stage_all_left: i64,
    unstage_all: Option<(i64, i64)>,
    bars: Option<(i64, i64)>,
}

/// Width of a file list widget in a details pane of `details_width`: `97%` of the pane, as in TS.
pub fn list_width(details_width: i64) -> i64 {
    (details_width.max(1) as f64 * 0.97).round().max(1.0) as i64
}

pub struct FilesWidgets {
    pub unstaged: Custom<FileList>,
    pub staged: Custom<FileList>,
    discard: Custom<ActionButton>,
    stage_all: Custom<ActionButton>,
    unstage_all: Custom<ActionButton>,
    files_bar: Custom<SplitBar>,
    composer_bar: Custom<SplitBar>,
}

impl FilesWidgets {
    pub fn new(app: &App, theme: &Theme, inbox: &Rc<Inbox>) -> Self {
        let list = |section: ListKind| {
            let mut list = FileList::new(theme.clone());
            let inbox = inbox.clone();
            list.on_event(move |cx, event| {
                let msg = match event {
                    FileListEvent::Click { row, .. } => Msg::FileClick { section, row },
                    FileListEvent::Wheel(delta) => Msg::FileWheel { section, delta },
                    FileListEvent::ToggleSection => Msg::FileToggleSection(section),
                    FileListEvent::RowAction { row, action } => Msg::FileRowAction {
                        section,
                        row,
                        action,
                    },
                    FileListEvent::Menu { row, x, y } => {
                        Msg::Overlay(OverlayMsg::FileMenu { section, row, x, y })
                    }
                };
                inbox.post(cx.app(), msg);
            });
            Custom::new(app, list).absolute()
        };
        let button = |label: &str, fg: Rgba, action: ChangesAction| {
            let mut button = ActionButton::new(theme.clone(), label, fg);
            let inbox = inbox.clone();
            button.on_press(move |cx| inbox.post(cx.app(), Msg::ChangesAction(action)));
            Custom::new(app, button).absolute().height(1)
        };
        let bar = |split: Split| {
            let mut bar = SplitBar::new(theme.clone());
            let inbox = inbox.clone();
            bar.on_event(move |cx, event| {
                let SplitEvent::Drag { y } = event;
                inbox.post(cx.app(), Msg::SplitDrag { split, y });
            });
            Custom::new(app, bar).absolute().height(1)
        };
        Self {
            unstaged: list(ListKind::Unstaged),
            staged: list(ListKind::Staged),
            discard: button(DISCARD_ALL_LABEL, theme.deleted, ChangesAction::Discard),
            stage_all: button(STAGE_ALL_LABEL, theme.added, ChangesAction::Stage),
            unstage_all: button(UNSTAGE_ALL_LABEL, theme.warning, ChangesAction::Unstage),
            files_bar: bar(Split::Files),
            composer_bar: bar(Split::Composer),
        }
    }

    /// Puts the widgets into the details pane.
    pub fn attach(&self, details: &View) {
        // Later widgets draw on top. The split bars lie over the last row of each list, as in TS.
        details
            .add(&self.unstaged)
            .add(&self.staged)
            .add(&self.files_bar)
            .add(&self.composer_bar)
            .add(&self.discard)
            .add(&self.stage_all)
            .add(&self.unstage_all);
    }
}

fn place_at(widget: &impl Widget, left: i64, top: i64, width: i64, height: i64) {
    let cells = |value: i64| u32::try_from(value.max(0)).unwrap_or(0);
    widget
        .position(Edge::Left, cells(left))
        .position(Edge::Top, cells(top))
        .width(cells(width))
        .height(cells(height));
}

impl Shell {
    pub fn files_snapshot_applied(&mut self) {
        let Some(snapshot) = self.snapshot.as_ref() else {
            return;
        };
        self.files.set_working_files(&snapshot.files);
        self.dirty |= Dirty::FILES;
    }

    fn details_content_height(&self) -> i64 {
        (i64::from(self.layout.height) - i64::from(PANE_TOP)).max(1)
    }

    /// Rows a list shows: its widget height without the label.
    fn viewport(&self, kind: ListKind) -> usize {
        let place = self.files_place();
        let rows = match kind {
            ListKind::Unstaged => place.unstaged,
            ListKind::Staged => place.staged,
            ListKind::Commit => place.unstaged,
        };
        rows.map_or(1, |(_, rows)| rows.max(1)) as usize
    }

    fn files_place(&self) -> Place {
        let files = &self.files;
        let width = self.layout.panes.details_width.max(1);
        let height = self.details_content_height();
        let commit = files.contents == Contents::Commit;
        let sections = layout_change_sections(ChangeSectionsInput {
            available: (height - 1).max(0),
            unstaged_collapsed: files.collapsed[0],
            staged_collapsed: files.collapsed[1],
            preferred_unstaged_height: files.preferred_unstaged_height,
            preferred_composer_height: files.preferred_composer_height,
        });
        let working_files = self.snapshot.as_ref().map_or(0, |s| s.files.len());
        // Where the commit card ends, from the details layout (`layout_details`).
        let commit_files_top = self.details_files_top();
        let commit_viewport =
            (file_viewport_size(ChangesView::Commit, height, commit_files_top) - 1).max(1);
        let changes = layout_changes(ChangesInputs {
            view: if commit {
                ChangesView::Commit
            } else {
                ChangesView::History
            },
            editing_commit: self.composer.editing(),
            diff_visible: false,
            history_filter_active: false,
            width,
            content_height: height,
            snapshot_file_count: working_files,
            commit_files_top,
            unstaged_viewport: commit_viewport,
            discard_button_width: string_width(DISCARD_ALL_LABEL) as i64,
            stage_all_button_width: string_width(STAGE_ALL_LABEL) as i64,
            unstage_all_button_width: string_width(UNSTAGE_ALL_LABEL) as i64,
            staged_collapsed: files.collapsed[1],
            staged_file_count: files.staged.len(),
            sections,
        });
        let mut place = Place {
            changes,
            unstaged: None,
            staged: None,
            discard_left: 0,
            stage_all_left: 0,
            unstage_all: None,
            bars: None,
        };
        match changes.geometry {
            ChangesGeometry::CommitFiles {
                unstaged_label_top,
                unstaged_text_height,
                ..
            } => place.unstaged = Some((unstaged_label_top, unstaged_text_height)),
            ChangesGeometry::Working(WorkingChangesGeometry {
                discard_left,
                stage_all_left,
                unstaged_label_top,
                staged_label_top,
                unstage_all_top,
                unstage_all_left,
                unstaged_text_height,
                staged_text_height,
                unstaged_divider,
                composer_divider,
                ..
            }) => {
                let rows = |visible: Option<bool>, rows: i64| {
                    if visible.unwrap_or(true) { rows } else { 0 }
                };
                place.unstaged = Some((
                    unstaged_label_top,
                    rows(changes.unstaged_text_visible, unstaged_text_height),
                ));
                place.staged = Some((
                    staged_label_top,
                    rows(changes.staged_text_visible, staged_text_height),
                ));
                place.discard_left = discard_left;
                place.stage_all_left = stage_all_left;
                if changes.unstage_all_visible == Some(true) {
                    place.unstage_all = Some((unstage_all_top, unstage_all_left));
                }
                place.bars = Some((unstaged_divider.top, composer_divider.top));
            }
            ChangesGeometry::CommitDiff { .. } | ChangesGeometry::Editing(_) => {}
        }
        place
    }

    /// The composer's geometry in the details pane: the working view's, or the full pane while a message is edited.
    pub(crate) fn composer_place(&self) -> Option<ComposerLayout> {
        match self.files_place().changes.geometry {
            ChangesGeometry::Working(working) => Some(working.composer),
            ChangesGeometry::Editing(composer) => Some(composer),
            ChangesGeometry::CommitFiles { .. } | ChangesGeometry::CommitDiff { .. } => None,
        }
    }

    /// Builds the data for the list widget of `section` from the state.
    fn list_data(&mut self, section: ListKind) -> FileListData {
        let kind = self.files.kind_of(section);
        let viewport = self.viewport(kind);
        let files = &mut self.files;
        let rows = files.rows(kind);
        let total = rows.len();
        let start = files.start[slot(kind)].min(total.saturating_sub(viewport));
        files.start[slot(kind)] = start;
        let rows: Vec<FileRow> = files.rows(kind)[start..(start + viewport).min(total)].to_vec();
        let working = kind != ListKind::Commit;
        let is_active = kind == files.active();
        let (status, count) = match kind {
            ListKind::Commit => (
                match (&files.commit.files, &files.commit.error) {
                    (_, Some(error)) => ListStatus::Failed(error.clone()),
                    (None, None) => ListStatus::Loading,
                    (Some(_), None) => ListStatus::Ready,
                },
                files.commit.files.as_ref().map_or(0, |files| files.len()),
            ),
            ListKind::Unstaged => (ListStatus::Ready, files.unstaged.len()),
            ListKind::Staged => (ListStatus::Ready, files.staged.len()),
        };
        FileListData {
            kind,
            count,
            collapsed: working && files.collapsed[slot(kind)],
            active: is_active && files.focus == Focus::Changes,
            start,
            rows,
            selected_path: is_active.then(|| files.selected_path.clone()).flatten(),
            status,
            compared: false,
            actions: working.then_some(match kind {
                ListKind::Staged => FileSection::Staged,
                _ => FileSection::Unstaged,
            }),
        }
    }

    /// Pushes the files state into the widgets. Runs from `sync`.
    pub(crate) fn sync_files(&mut self) {
        if !self.dirty.intersects(Dirty::FILES | Dirty::LAYOUT) {
            return;
        }
        let details = self.layout.panes.details_visible;
        let place = self.files_place();
        let width = self.layout.panes.details_width.max(1);
        let list_w = list_width(width);
        let commit = self.files.contents == Contents::Commit;
        let vis = place.changes.visibility;
        let unstaged = self.list_data(ListKind::Unstaged);
        let staged = self.list_data(ListKind::Staged);
        let widgets = &self.widgets.files;
        let label_rows = |place: Option<(i64, i64)>| place.map(|(top, rows)| (top, 1 + rows));
        match label_rows(place.unstaged) {
            Some((top, height)) => {
                place_at(&widgets.unstaged, 1, top, list_w, height);
                widgets.unstaged.visible(details);
            }
            None => {
                widgets.unstaged.visible(false);
            }
        }
        let staged_shown = !commit && details;
        match label_rows(place.staged) {
            Some((top, height)) if staged_shown => {
                place_at(&widgets.staged, 1, top, list_w, height);
                widgets.staged.visible(true);
            }
            _ => {
                widgets.staged.visible(false);
            }
        }
        let working = !commit && details;
        place_at(
            &widgets.discard,
            place.discard_left,
            0,
            string_width(DISCARD_ALL_LABEL) as i64,
            1,
        );
        place_at(
            &widgets.stage_all,
            place.stage_all_left,
            0,
            string_width(STAGE_ALL_LABEL) as i64,
            1,
        );
        widgets
            .discard
            .visible(working && vis.discard_button != Some(false));
        widgets
            .stage_all
            .visible(working && vis.stage_all_button != Some(false));
        match place.unstage_all {
            Some((top, left)) if working => {
                place_at(
                    &widgets.unstage_all,
                    left,
                    top,
                    string_width(UNSTAGE_ALL_LABEL) as i64,
                    1,
                );
                widgets.unstage_all.visible(true);
            }
            _ => {
                widgets.unstage_all.visible(false);
            }
        }
        match place.bars {
            Some((files_top, composer_top)) if working => {
                place_at(&widgets.files_bar, 0, files_top, width, 1);
                place_at(&widgets.composer_bar, 0, composer_top, width, 1);
                widgets.files_bar.visible(true);
                widgets.composer_bar.visible(true);
            }
            _ => {
                widgets.files_bar.visible(false);
                widgets.composer_bar.visible(false);
            }
        }
        let (unstaged, staged) = (Rc::new(unstaged), Rc::new(staged));
        widgets.unstaged.update(|list| list.set_data(unstaged));
        widgets.staged.update(|list| list.set_data(staged));
    }

    // -- input

    /// A left press on a history row. `history_click` already opened the commit or left the commit view. A press on
    /// the working row also returns the changes pane to the unstaged list.
    pub(crate) fn files_history_clicked(&mut self) {
        self.files.focus = Focus::History;
        if self.history.selection == HistorySelection::Working {
            self.files.mode = FileSection::Unstaged;
        }
        self.dirty |= Dirty::FILES | Dirty::HISTORY;
    }

    pub(crate) fn switch_pane(&mut self) {
        self.files.focus = match self.files.focus {
            Focus::History => Focus::Changes,
            Focus::Changes => Focus::History,
        };
        self.dirty |= Dirty::FILES | Dirty::HISTORY;
    }

    pub(crate) fn focus_changes(&mut self) {
        if self.files.focus != Focus::Changes {
            self.files.focus = Focus::Changes;
            self.dirty |= Dirty::FILES | Dirty::HISTORY;
        }
    }

    /// Enter: in the changes pane it opens the selected file, in the history pane it opens the selected commit.
    pub(crate) fn files_enter(&mut self, app: &App) {
        if self.files.focus == Focus::Changes {
            match self.files.selected.clone() {
                Some(file) => self.inbox.post(app, Msg::FileOpened(file)),
                None => self.notice = Some("No file selected".to_string()),
            }
        } else if !self.commit_open() {
            self.open_commit();
        }
    }

    /// `t`: switches between the unstaged and staged lists.
    pub(crate) fn files_toggle_mode(&mut self) {
        if self.files.contents == Contents::Commit {
            return;
        }
        self.files.mode = match self.files.mode {
            FileSection::Unstaged => FileSection::Staged,
            FileSection::Staged => FileSection::Unstaged,
        };
        self.files.selected_path = None;
        self.files.last_index = 0;
        self.files.focus = Focus::Changes;
        self.dirty |= Dirty::FILES | Dirty::HISTORY;
    }

    /// Ports `moveFile`: steps through the visible files of the active list.
    pub(crate) fn move_file(&mut self, app: &App, delta: i64) {
        if !self.diff.selected_rows.is_empty() {
            self.clear_line_selection(false);
        }
        // An open file history takes the keys, as `historyFilterActive` does in TS.
        if self.scroll_file_history(app, delta) {
            return;
        }
        self.focus_changes();
        let kind = self.files.active();
        let paths: Vec<String> = self
            .files
            .rows(kind)
            .iter()
            .filter(|row| !row.directory)
            .map(|row| row.path.clone())
            .collect();
        if paths.is_empty() {
            return;
        }
        let current = self
            .files
            .selected_path
            .as_ref()
            .and_then(|path| paths.iter().position(|candidate| candidate == path));
        let next = match current {
            Some(at) => (at as i64 + delta).clamp(0, paths.len() as i64 - 1) as usize,
            None if delta < 0 => paths.len() - 1,
            None => 0,
        };
        self.files.selected_path = Some(paths[next].clone());
        self.files.last_index = next;
        self.ensure_file_visible();
        self.dirty |= Dirty::FILES;
    }

    /// Scrolls the active list so the selected row is on screen. Ports `ensureFileVisible`.
    fn ensure_file_visible(&mut self) {
        let kind = self.files.active();
        let viewport = self.viewport(kind);
        let selected = self.files.selected_path.clone();
        let rows = self.files.rows(kind);
        let at = selected.and_then(|path| {
            rows.iter()
                .position(|row| !row.directory && row.path == path)
        });
        let max_start = rows.len().saturating_sub(viewport);
        let start = &mut self.files.start[slot(kind)];
        if let Some(at) = at {
            if at < *start {
                *start = at;
            } else if at >= *start + viewport {
                *start = at + 1 - viewport;
            }
        }
        *start = (*start).min(max_start);
    }

    /// Ports `filesClick` for a left press on a row of the widget of `section`.
    pub(crate) fn file_click(&mut self, app: &App, section: ListKind, row: usize) {
        self.focus_changes();
        let section_mode = match section {
            ListKind::Staged => FileSection::Staged,
            _ => FileSection::Unstaged,
        };
        if self.files.contents == Contents::Working && self.files.mode != section_mode {
            self.files.mode = section_mode;
            self.files.selected_path = None;
            self.files.last_index = 0;
        }
        let kind = self.files.kind_of(section);
        let Some(entry) = self.files.rows(kind).get(row).cloned() else {
            return;
        };
        self.dirty |= Dirty::FILES;
        if entry.directory {
            self.files.toggle_directory(&entry.path);
            return;
        }
        self.files.selected_path = Some(entry.path);
        self.files.resolve_selection();
        self.ensure_file_visible();
        if let Some(file) = self.files.compute_selected() {
            self.inbox.post(app, Msg::FileOpened(file));
        }
    }

    pub(crate) fn file_wheel(&mut self, section: ListKind, delta: i32) {
        self.focus_changes();
        let kind = self.files.kind_of(section);
        let viewport = self.viewport(kind);
        let total = self.files.rows(kind).len();
        let max_start = total.saturating_sub(viewport) as i64;
        let start = &mut self.files.start[slot(kind)];
        *start = (*start as i64 + i64::from(delta)).clamp(0, max_start) as usize;
        self.dirty |= Dirty::FILES;
    }

    pub(crate) fn file_toggle_section(&mut self, section: ListKind) {
        if self.files.contents == Contents::Commit {
            return;
        }
        let index = slot(section).min(1);
        self.files.collapsed[index] = !self.files.collapsed[index];
        self.dirty |= Dirty::FILES;
    }

    /// Ports `resizeChangeSplit` and `resizeComposer`. `y` is a screen row.
    pub(crate) fn split_drag(&mut self, split: Split, y: u16) {
        if self.files.contents != Contents::Working {
            return;
        }
        let y = i64::from(y) - i64::from(PANE_TOP);
        match split {
            Split::Files => self.files.preferred_unstaged_height = Some((y - 2).max(0)),
            Split::Composer => {
                self.files.preferred_composer_height =
                    Some((self.details_content_height() - 2 - y).max(0));
            }
        }
        self.dirty |= Dirty::FILES;
    }

    // -- loading the files of a commit

    /// Runs after every message. Keeps the view, the commit being loaded, the selection and `files.selected` in
    /// step with the history selection and the snapshot.
    pub(crate) fn settle_files(&mut self, app: &App) {
        if self.snapshot.is_none() {
            return;
        }
        if self.commit_open() && self.history.selection == HistorySelection::Working {
            self.close_details_for_working();
        }
        let target = match self.files.contents {
            Contents::Commit => self.history.selected_sha().map(str::to_owned),
            Contents::Working => None,
        };
        if target != self.files.commit.sha {
            self.retarget_commit_files(app, target);
        }
        self.files.resolve_selection();
        let selected = self.files.compute_selected();
        if selected != self.files.selected {
            self.files.selected = selected.clone();
            self.dirty |= Dirty::FILES;
        }
        if selected != self.files.announced {
            self.files.announced = selected.clone();
            self.inbox.post(app, Msg::FileSelected(selected));
        }
        if self.files.commit.sha.is_some()
            && !self.files.commit.requested
            && self.files.timer.is_none()
        {
            self.start_commit_files(app);
        }
    }

    fn retarget_commit_files(&mut self, app: &App, target: Option<String>) {
        self.tasks.commit_files.cancel();
        if let Some(timer) = self.files.timer.take() {
            app.cancel_timer(timer);
        }
        self.files.commit = CommitFiles {
            sha: target.clone(),
            ..CommitFiles::default()
        };
        self.dirty |= Dirty::FILES;
        if target.is_some() && !self.files.debounce.is_zero() {
            let inbox = self.inbox.clone();
            self.files.timer = Some(app.set_timeout(self.files.debounce, move |cx| {
                inbox.post(cx.app(), Msg::CommitFilesDue)
            }));
        }
    }

    pub(crate) fn commit_files_due(&mut self, app: &App) {
        self.files.timer = None;
        if self.files.commit.sha.is_some() && !self.files.commit.requested {
            self.start_commit_files(app);
        }
    }

    fn start_commit_files(&mut self, app: &App) {
        let Some(sha) = self.files.commit.sha.clone() else {
            return;
        };
        self.files.commit.requested = true;
        let repo = self.repo.clone();
        self.spawn(
            app,
            |tasks| &mut tasks.commit_files,
            async move { repo.commit_files(&sha, None).await },
            Msg::CommitFiles,
        );
    }

    pub(crate) fn commit_files_loaded(&mut self, result: GitResult<Vec<ChangedFile>>) {
        match result {
            Ok(files) => self.files.commit.files = Some(files.into()),
            Err(error) => {
                self.files.commit.error = Some(error.to_string());
                self.notify_error(error.to_string());
            }
        }
        self.dirty |= Dirty::FILES;
    }

    /// A hover action on a row: Stage, Discard or Unstage the row's files (`descendantFiles`).
    pub(crate) fn file_row_action(
        &mut self,
        app: &App,
        section: ListKind,
        row: usize,
        action: FileRowAction,
    ) {
        let Some((files, directory)) = self.files.row_files(section, row) else {
            return;
        };
        let action = match action {
            FileRowAction::Stage => FileAction::Stage,
            FileRowAction::Discard => FileAction::Discard,
            FileRowAction::Unstage => FileAction::Unstage,
        };
        self.run_file_action(app, action, files, directory);
    }

    pub(crate) fn changes_action(&mut self, app: &App, action: ChangesAction) {
        match action {
            ChangesAction::Discard => self.discard_all(app),
            ChangesAction::Stage => self.stage_all(app),
            ChangesAction::Unstage => self.unstage_all(app),
        }
    }
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
