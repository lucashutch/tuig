//! The diff pane. Ports `loadDiff` and `cancelDiff` in `src/ui/runtime-data.ts`, the line selection and staging of
//! `src/ui/runtime-diff-selection.ts`, `runHunkAction` and `stageFirstHunk` in `src/ui/runtime-commands.ts`, and
//! the mutation guard of `perform`.
//!
//! The pane shows the diff of [`DiffState::file`]. It opens when the user opens a file in the files pane
//! (`Msg::FileOpened`: a click or Enter). Moving the file selection while the pane is open shows the new file
//! (`Msg::FileSelected`), as `moveFile` does in TS. With the pane closed, selecting a file loads nothing.
//!
//! Mutations run in their own task slot, so a selection change never cancels them. After a mutation the shell
//! refreshes the snapshot and reloads the diff.

use crate::selected_file::{FileSource, SelectedFile};
use crate::shell::{Dirty, GitResult, Inbox, Msg, PANE_TOP, Shell};
use opentui::prelude::*;
use opentui::syntax::filetype_for_path;
use std::collections::HashSet;
use std::future::Future;
use std::rc::Rc;
use tuig_git::hunks::{Preserve, hunk_at_row, select_patch_lines, split_patch_hunks};
use tuig_git::process::GitError;
use tuig_git::types::DiffRequest;
use tuig_ui_model::diff_lines::{DiffLineKind, DiffLineTarget};
use tuig_ui_model::diff_policy::{DIFF_DISPLAY_MAX_BYTES, can_highlight_diff};
use tuig_ui_model::history_viewport::HistorySelection;
use tuig_ui_model::theme::Theme;
use tuig_widgets::diff::{DiffDocument, DiffEvent, DiffPane, effective_diff_view};

/// Context lines around each change. `loadDiff` asks for 6.
const DIFF_CONTEXT: u32 = 6;

/// A hunk action from the diff menu. `runHunkAction`.
#[expect(
    dead_code,
    reason = "the right-click diff menu that offers these waits for the popup port"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkAction {
    Stage,
    Unstage,
    Revert,
}

#[derive(Default)]
pub struct DiffState {
    /// The file the pane shows. `None` when the pane is closed.
    pub file: Option<SelectedFile>,
    pub document: Option<Rc<DiffDocument>>,
    /// Shown in place of the document: loading, empty, failed or too large.
    pub message: String,
    /// The last load stopped at `DIFF_DISPLAY_MAX_BYTES`. Shift+L loads it anyway. `diffTooLarge`.
    pub too_large: bool,
    /// The side-by-side preference. Applies when the pane is at least `SPLIT_DIFF_MIN_WIDTH` wide.
    pub side_by_side: bool,
    /// Raw patch rows selected for line staging.
    pub selected_rows: HashSet<usize>,
    /// The document the selected rows belong to. A new document invalidates them. `snapshot` in TS.
    pub selection_document: Option<Rc<DiffDocument>>,
    pub drag_anchor: Option<usize>,
    pub drag_selecting: bool,
    /// The label of the running mutation. `mutationBusy`.
    pub mutation: Option<String>,
}

impl DiffState {
    pub fn new() -> Self {
        Self {
            side_by_side: true,
            ..Self::default()
        }
    }

    pub fn is_open(&self) -> bool {
        self.file.is_some()
    }

    fn working(&self) -> bool {
        self.file
            .as_ref()
            .is_some_and(|file| file.source.is_working())
    }

    fn staged(&self) -> bool {
        self.file
            .as_ref()
            .is_some_and(|file| file.source == FileSource::WorkingStaged)
    }

    /// The selected rows still belong to the document on screen.
    fn selection_current(&self) -> bool {
        match (&self.selection_document, &self.document) {
            (Some(selected), Some(shown)) => Rc::ptr_eq(selected, shown),
            _ => false,
        }
    }
}

/// Builds the pane widget and forwards its events to the inbox.
pub fn diff_widget(app: &App, theme: &Theme, inbox: &Rc<Inbox>) -> Custom<DiffPane> {
    tuig_widgets::grammars::register_all();
    let mut pane = DiffPane::new(theme);
    let inbox = inbox.clone();
    pane.on_event(move |cx, event| inbox.post(cx.app(), Msg::DiffInput(event)));
    Custom::new(app, pane).absolute().visible(false)
}

fn request_for(file: &SelectedFile, context: u32, max_bytes: Option<usize>) -> DiffRequest {
    let (staged, commit) = match &file.source {
        FileSource::WorkingUnstaged => (false, None),
        FileSource::WorkingStaged => (true, None),
        FileSource::Commit(sha) => (false, Some(sha.clone())),
    };
    DiffRequest {
        path: Some(file.path.clone()),
        original_path: file.original_path.clone(),
        staged,
        commit,
        context: Some(context),
        max_bytes,
        ..DiffRequest::default()
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

impl Shell {
    /// Shows the diff of `file`, or closes the pane for `None`. The files pane calls this for `Msg::FileSelected`.
    pub(crate) fn show_file_diff(&mut self, app: &App, file: Option<SelectedFile>) {
        if self.diff.file != file {
            self.clear_line_selection(false);
            self.diff.document = None;
        }
        self.diff.file = file;
        self.load_diff(app, false);
    }

    /// A new file is highlighted. `moveFile` reloads the diff only while it is open. TS opens it on a click or
    /// Enter, which arrive as `Msg::FileOpened`.
    pub(crate) fn file_selected(&mut self, app: &App, file: Option<SelectedFile>) {
        if !self.diff.is_open() || self.diff.file == file {
            return;
        }
        match file {
            Some(file) => self.show_file_diff(app, Some(file)),
            None => self.close_diff(),
        }
    }

    /// Ports `closeDiff`: hides the pane and shows the history again.
    pub(crate) fn close_diff(&mut self) {
        self.tasks.diff.cancel();
        self.clear_line_selection(false);
        self.diff.file = None;
        self.diff.document = None;
        self.diff.message.clear();
        self.diff.too_large = false;
        self.dirty |= Dirty::DIFF | Dirty::HISTORY;
    }

    /// Ports `loadDiff`. Keeps the document on screen while the same file reloads, so a refresh does not flicker.
    /// `allow_large` loads a diff past the display limit, only after the last load hit it.
    pub(crate) fn load_diff(&mut self, app: &App, allow_large: bool) {
        if allow_large && !self.diff.too_large {
            return;
        }
        self.tasks.diff.cancel();
        self.diff.too_large = false;
        self.dirty |= Dirty::DIFF;
        let Some(file) = self.diff.file.clone() else {
            self.diff.document = None;
            return;
        };
        if self.diff.document.is_none() {
            self.diff.message = "Loading diff…".to_owned();
        }
        let request = request_for(
            &file,
            DIFF_CONTEXT,
            (!allow_large).then_some(DIFF_DISPLAY_MAX_BYTES),
        );
        let repo = self.repo.clone();
        let path = file.path;
        self.spawn(
            app,
            |tasks| &mut tasks.diff,
            async move {
                let patch = repo.diff(&request).await?;
                if !allow_large && patch.len() > DIFF_DISPLAY_MAX_BYTES {
                    return Err(GitError::OutputLimit(
                        tuig_git::process::GitOutputLimitError {
                            args: Vec::new(),
                            limit_bytes: DIFF_DISPLAY_MAX_BYTES,
                        },
                    ));
                }
                let filetype =
                    filetype_for_path(&path).filter(|_| !allow_large && can_highlight_diff(&patch));
                Ok(DiffDocument::new(patch, filetype))
            },
            Msg::Diff,
        );
    }

    pub(crate) fn diff_loaded(&mut self, result: GitResult<DiffDocument>) {
        self.dirty |= Dirty::DIFF;
        match result {
            Ok(document) => {
                self.diff.message = if document.patch.is_empty() {
                    "No textual diff to display.".to_owned()
                } else {
                    String::new()
                };
                if document.filetype.is_none() && !can_highlight_diff(&document.patch) {
                    self.notice =
                        Some("Large diff: syntax highlighting and wrapping disabled".to_owned());
                }
                // An unchanged reload keeps the document, so the scroll position and the selected rows stay.
                if self
                    .diff
                    .document
                    .as_ref()
                    .is_some_and(|shown| shown.patch == document.patch)
                {
                    return;
                }
                self.diff.document = Some(Rc::new(document));
            }
            Err(GitError::OutputLimit(_)) => {
                self.diff.document = None;
                self.diff.too_large = true;
                self.diff.message = "Diff exceeds 5 MiB. Loading it may use substantial RAM.\nPress Shift+L to load without highlighting, or Esc to close.".to_owned();
                self.notice = Some("Diff too large · Shift+L to load anyway".to_owned());
            }
            Err(error) => {
                self.diff.document = None;
                self.diff.message = "Failed to load diff.".to_owned();
                self.notice = Some(error.to_string());
            }
        }
    }

    /// A refresh re-reads a working-tree diff, as `refresh` does in TS.
    pub(crate) fn diff_after_refresh(&mut self, app: &App) {
        if self.diff.working() && !self.tasks.diff.busy() {
            self.load_diff(app, false);
        }
    }

    pub(crate) fn diff_input(&mut self, app: &App, event: DiffEvent) {
        match event {
            DiffEvent::Press {
                target,
                button,
                ctrl,
                alt,
                ..
            } => self.diff_press(target, button, ctrl, alt),
            DiffEvent::Drag { target } => self.diff_drag(target),
            DiffEvent::Release => self.diff.drag_anchor = None,
            DiffEvent::Copied(_) => {
                let _ = app;
                self.notice = Some("Copied selection".to_owned());
            }
        }
    }

    /// Ports `RuntimeDiffSelectionController.click`. A left press on a changed line of a working-tree diff selects
    /// it. Ctrl or Alt adds or removes it instead, and Alt starts a range drag. A right press selects the line when
    /// it is not part of the selection. The menus that follow a right press are not ported yet.
    fn diff_press(
        &mut self,
        target: Option<DiffLineTarget>,
        button: MouseButton,
        ctrl: bool,
        alt: bool,
    ) {
        let Some(target) = target.filter(|target| target.kind != DiffLineKind::Context) else {
            return;
        };
        if !self.diff.working() {
            return;
        }
        let raw = target.raw_row;
        match button {
            MouseButton::Left => {
                if !self.diff.selection_current() {
                    self.diff.selected_rows.clear();
                    self.diff.selection_document = self.diff.document.clone();
                }
                let rows = &mut self.diff.selected_rows;
                if !ctrl && !alt {
                    rows.clear();
                    rows.insert(raw);
                } else if !rows.remove(&raw) {
                    rows.insert(raw);
                }
                if alt {
                    self.diff.drag_anchor = Some(raw);
                    self.diff.drag_selecting = rows.contains(&raw);
                }
                let count = rows.len();
                self.notice = Some(if count > 0 {
                    let action = if self.diff.staged() {
                        "unstage"
                    } else {
                        "stage"
                    };
                    format!("{count} line{} selected · Enter to {action}", plural(count))
                } else {
                    "Line selection cleared".to_owned()
                });
            }
            MouseButton::Right => {
                if !self.diff.selection_current() || !self.diff.selected_rows.contains(&raw) {
                    self.diff.selected_rows = HashSet::from([raw]);
                    self.diff.selection_document = self.diff.document.clone();
                }
            }
            _ => return,
        }
        self.dirty |= Dirty::DIFF;
    }

    /// Ports `drag`: an Alt drag adds or removes every changed row between the anchor and the pointer.
    fn diff_drag(&mut self, target: Option<DiffLineTarget>) {
        let (Some(anchor), Some(target)) = (self.diff.drag_anchor, target) else {
            return;
        };
        if !self.diff.selection_current() {
            return;
        }
        let Some(document) = self.diff.document.clone() else {
            return;
        };
        for row in document.changed_rows_between(anchor, target.raw_row) {
            if self.diff.drag_selecting {
                self.diff.selected_rows.insert(row);
            } else {
                self.diff.selected_rows.remove(&row);
            }
        }
        self.dirty |= Dirty::DIFF;
    }

    /// Ports `clear`.
    pub(crate) fn clear_line_selection(&mut self, notify: bool) {
        self.diff.drag_anchor = None;
        self.diff.selected_rows.clear();
        self.diff.selection_document = None;
        self.dirty |= Dirty::DIFF;
        if notify {
            self.notice = Some("Line selection cleared".to_owned());
        }
    }

    /// Ports `apply`: stages or unstages the selected lines, or discards them from the working tree.
    pub(crate) fn apply_selected_lines(&mut self, app: &App, discard: bool) {
        let staged = self.diff.staged();
        let (true, false, Some(document)) = (
            self.diff.working() && self.diff.selection_current(),
            self.diff.selected_rows.is_empty(),
            self.diff.document.clone(),
        ) else {
            return self.clear_line_selection(true);
        };
        let preserve = if discard || staged {
            Preserve::New
        } else {
            Preserve::Old
        };
        let patch = select_patch_lines(&document.patch, &self.diff.selected_rows, preserve);
        if patch.is_empty() {
            self.notice = Some("No changed lines selected".to_owned());
            return;
        }
        let label = if discard {
            "Discarding selected lines…"
        } else if staged {
            "Unstaging selected lines…"
        } else {
            "Staging selected lines…"
        };
        self.diff.selected_rows.clear();
        self.diff.selection_document = None;
        self.dirty |= Dirty::DIFF;
        let repo = self.repo.clone();
        self.perform(app, label, async move {
            if discard {
                repo.discard_patch(&patch).await
            } else {
                repo.apply_patch(&patch, staged).await
            }
        });
    }

    /// The hunk around a raw patch row of the diff on screen, for the hunk actions of the diff menu.
    #[expect(
        dead_code,
        reason = "the right-click diff menu waits for the popup port"
    )]
    pub(crate) fn hunk_patch_at(&self, raw_row: usize) -> Option<String> {
        if !self.diff.working() {
            return None;
        }
        let document = self.diff.document.as_ref()?;
        hunk_at_row(&document.patch, raw_row).map(|hunk| hunk.patch)
    }

    /// Ports `runHunkAction`. The TS app confirms a revert first; the caller owns that prompt.
    #[expect(
        dead_code,
        reason = "the right-click diff menu waits for the popup port"
    )]
    pub(crate) fn hunk_action(&mut self, app: &App, action: HunkAction, patch: String) {
        let repo = self.repo.clone();
        let label = match action {
            HunkAction::Stage => "Staging hunk…",
            HunkAction::Unstage => "Unstaging hunk…",
            HunkAction::Revert => "Reverting hunk…",
        };
        self.perform(app, label, async move {
            match action {
                HunkAction::Stage => repo.apply_patch(&patch, false).await,
                HunkAction::Unstage => repo.apply_patch(&patch, true).await,
                HunkAction::Revert => repo.discard_patch(&patch).await,
            }
        });
    }

    /// Ports `stageFirstHunk`: stages, or for a staged file unstages, the first hunk of a fresh three-line diff.
    pub(crate) fn stage_first_hunk(&mut self, app: &App) {
        let Some(file) = self
            .diff
            .file
            .clone()
            .filter(|file| file.source.is_working())
        else {
            return;
        };
        let staged = file.source == FileSource::WorkingStaged;
        let request = request_for(&file, 3, None);
        let repo = self.repo.clone();
        self.perform(app, "Applying hunk…", async move {
            let patch = repo.diff(&request).await?;
            let Some(hunk) = split_patch_hunks(&patch).into_iter().next() else {
                return Err(GitError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "No applicable hunk",
                )));
            };
            repo.apply_patch(&hunk.patch, staged).await
        });
    }

    /// Ports `perform` for local index work: one mutation at a time, in its own slot.
    fn perform<F>(&mut self, app: &App, label: &str, future: F)
    where
        F: Future<Output = GitResult<()>> + Send + 'static,
    {
        if let Some(running) = &self.diff.mutation {
            self.notice = Some(format!("{running} is still running"));
            return;
        }
        self.diff.mutation = Some(label.to_owned());
        self.notice = Some(label.to_owned());
        self.spawn(app, |tasks| &mut tasks.mutation, future, Msg::Mutation);
    }

    pub(crate) fn mutation_done(&mut self, app: &App, result: GitResult<()>) {
        let label = self.diff.mutation.take().unwrap_or_default();
        match result {
            Ok(()) => self.notice = None,
            Err(GitError::Aborted(_)) => {
                self.notice = Some(format!("Cancelled {}", label.to_lowercase()));
            }
            Err(error) => self.notice = Some(error.to_string()),
        }
        self.request_refresh(app, false);
        if self.diff.working() {
            self.load_diff(app, false);
        }
    }

    /// Ports `escapeKey` for the diff: clears a line selection, or else closes the pane. Returns false when the
    /// pane was closed already.
    pub(crate) fn diff_escape(&mut self) -> bool {
        if !self.diff.selected_rows.is_empty() {
            self.clear_line_selection(true);
            return true;
        }
        if self.diff.is_open() {
            let working = self.diff.working();
            self.close_diff();
            // A diff of working changes came from the history view, so `closeDiff` selects the working row.
            // A commit diff returns to the commit view, which stays as it is.
            if working && self.has_working() {
                self.history.selection = HistorySelection::Working;
                self.history.viewport.detached = false;
            }
            return true;
        }
        false
    }

    pub(crate) fn toggle_diff_view(&mut self) {
        self.diff.side_by_side = !self.diff.side_by_side;
        self.dirty |= Dirty::DIFF;
    }

    /// Pushes diff state into the pane and shows it over the history pane, as the TS app does.
    pub(crate) fn sync_diff(&mut self) {
        if !self.dirty.intersects(Dirty::DIFF | Dirty::LAYOUT) {
            return;
        }
        let panes = self.layout.panes;
        let open = self.diff.is_open();
        let widgets = &self.widgets;
        let _ = widgets.history.visible(!open);
        let _ = widgets.diff.visible(open);
        crate::sync::place(
            &widgets.diff,
            panes.history_content_left,
            i64::from(PANE_TOP),
            panes.history_content_width,
            panes.history_text_height,
        );
        let view = effective_diff_view(self.diff.side_by_side, panes.history_content_width);
        let document = self.diff.document.clone();
        let message = self.diff.message.clone();
        let rows = if self.diff.selection_current() {
            self.diff.selected_rows.clone()
        } else {
            HashSet::new()
        };
        widgets.diff.update(|pane| {
            pane.set_view(view);
            pane.set_document(document);
            pane.set_message(message);
            pane.set_selected_rows(rows);
        });
    }
}

#[cfg(test)]
#[path = "diff_tests.rs"]
mod tests;
