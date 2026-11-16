//! Right-click entry points to the context menus: the history rows (`historyClick` in `src/ui/runtime-history.ts`),
//! the file rows (`filesClick` in `src/ui/runtime-files.ts`) and the diff lines
//! (`RuntimeDiffSelectionController.click` in `src/ui/runtime-diff-selection.ts`).
//!
//! Choosing "Show file history" or a blame entry from these menus starts the file history and blame views that
//! `screens/details.rs` implements.

use crate::screens::diff::HunkAction;
use crate::selected_file::FileSource;
use crate::shell::{Dirty, Shell};
use opentui::prelude::*;
use tuig_git::types::{ChangedFile, FileState};
use tuig_ui_model::diff_lines::{DiffLineKind, DiffLineTarget, DiffSide};
use tuig_ui_model::graph_menu::{
    ConfirmRequest, GraphMenuAction, GraphMenuItem, GraphMenuTarget, hunk_menu_items,
};
use tuig_ui_model::history_viewport::HistorySelection;
use tuig_widgets::decorations::{primary_decoration_ref, resolve_head_sha};
use tuig_widgets::files::ListKind;

use crate::screens::files::Contents;
use crate::screens::popup::MenuRequest;

/// The hunk entries of the diff menus. They come from a change to the TypeScript app that is not committed yet.
/// Turn them on, and re-record the `diff-menu` golden, when that change lands.
const DIFF_HUNK_MENU: bool = false;

/// The tag behind a row that has no branch label. `primaryDecorationTag`.
fn primary_decoration_tag(decorations: &[String]) -> Option<String> {
    if decorations.iter().any(|label| !label.starts_with("tag: ")) {
        return None;
    }
    decorations
        .iter()
        .find_map(|label| label.strip_prefix("tag: "))
        .map(str::to_owned)
}

impl Shell {
    /// A right press on a history row: selects the row and opens its menu.
    pub(crate) fn history_menu(&mut self, _app: &App, row: usize, on_label: bool, x: i64, y: i64) {
        let has_working = self.has_working();
        self.history.pending_scroll = 0;
        self.history.viewport.detached = false;
        self.history.selection = HistorySelection::from_row(row, has_working);
        self.dirty |= Dirty::HISTORY;
        self.files_history_clicked();
        let HistorySelection::Commit(index) = self.history.selection else {
            // The working row has no menu. It returns to the working changes, as a left press does.
            return self.close_details_for_working();
        };
        let Some(commit) = self.history.commits.get(index).cloned() else {
            return;
        };
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        let branch = on_label
            .then(|| {
                primary_decoration_ref(&commit.decorations, &snapshot.branches, &self.history.refs)
                    .cloned()
            })
            .flatten();
        let tag = on_label
            .then(|| primary_decoration_tag(&commit.decorations))
            .flatten();
        let stash = snapshot
            .stashes
            .iter()
            .find(|stash| stash.sha == commit.sha)
            .cloned();
        self.open_graph_menu(
            x,
            y,
            GraphMenuTarget {
                sha: commit.sha,
                branch,
                tag,
                stash,
                ..GraphMenuTarget::default()
            },
        );
    }

    /// A right press on a file row. Directories have no menu.
    pub(crate) fn file_menu(&mut self, _app: &App, section: ListKind, row: usize, x: i64, y: i64) {
        self.focus_changes();
        let Some((files, directory)) = self.files.row_files(section, row) else {
            return;
        };
        let (true, Some(file)) = (!directory, files.into_iter().next()) else {
            return;
        };
        let sha = if self.files.contents == Contents::Commit {
            self.files.commit.sha.clone().unwrap_or_default()
        } else {
            String::new()
        };
        self.open_graph_menu(
            x,
            y,
            GraphMenuTarget {
                sha,
                file: Some(file),
                file_staged: section == ListKind::Staged,
                ..GraphMenuTarget::default()
            },
        );
    }

    /// The checked-out commit. `headSha`.
    fn head_sha(&self) -> Option<String> {
        let snapshot = self.snapshot.as_ref()?;
        snapshot
            .head_sha
            .clone()
            .or_else(|| resolve_head_sha(&snapshot.branches, &self.history.commits))
    }

    /// A right press in the diff. Ports the right-button half of `RuntimeDiffSelectionController.click`.
    pub(crate) fn diff_context_menu(&mut self, target: Option<DiffLineTarget>, x: i64, y: i64) {
        let Some(file) = self.diff.file.clone() else {
            return;
        };
        let working = file.source.is_working();
        let changed = target.filter(|target| target.kind != DiffLineKind::Context);
        let hunk = if working && DIFF_HUNK_MENU {
            target.and_then(|target| self.hunk_patch_at(target.raw_row))
        } else {
            None
        };
        if let (true, Some(target)) = (working, changed) {
            // After a mutation the shown document is outdated until the reload finishes.
            if self.diff.mutation.is_some() || self.tasks.diff.busy() {
                return;
            }
            if !self.diff.selection_current() || !self.diff.selected_rows.contains(&target.raw_row)
            {
                self.diff.selected_rows = std::collections::HashSet::from([target.raw_row]);
                self.diff.selection_document = self.diff.document.clone();
                self.dirty |= Dirty::DIFF;
            }
        }
        if working && !self.diff.selected_rows.is_empty() && self.diff.selection_current() {
            let staged = self.diff.staged();
            let mut items = vec![GraphMenuItem::new(if staged {
                "Unstage selected"
            } else {
                "Stage selected"
            })];
            if !staged {
                items.push(GraphMenuItem::new("Discard selected").destructive());
            }
            items.push(GraphMenuItem::new("Clear selection"));
            if hunk.is_some() {
                items.push(GraphMenuItem::separator());
                items.extend(hunk_menu_items(staged));
            }
            self.open_popup(MenuRequest {
                title: "Selected lines".to_owned(),
                items,
                x,
                y,
                selected: None,
                on_select: Box::new(move |shell, app, item| {
                    if let (Some(patch), Some(action)) = (hunk, item.action) {
                        shell.hunk_menu_action(app, action, patch);
                    } else if item.label == "Clear selection" {
                        shell.clear_line_selection(true);
                    } else {
                        shell.apply_selected_lines(app, item.label == "Discard selected");
                    }
                }),
            });
            return;
        }
        let Some(target) = target else {
            return;
        };
        let (sha, path) = match &file.source {
            FileSource::Commit(commit) => {
                let selected = self
                    .selected_commit()
                    .filter(|selected| &selected.sha == commit)
                    .cloned();
                match (target.side, selected) {
                    (DiffSide::Old, Some(selected)) => (
                        selected.parents.first().cloned().unwrap_or_default(),
                        file.original_path
                            .clone()
                            .unwrap_or_else(|| file.path.clone()),
                    ),
                    (DiffSide::New, Some(selected)) => (selected.sha, file.path.clone()),
                    // The commit is not selected, so its parents are unknown.
                    (_, None) => (commit.clone(), file.path.clone()),
                }
            }
            _ if target.kind != DiffLineKind::Added => (
                self.head_sha().unwrap_or_default(),
                file.original_path
                    .clone()
                    .unwrap_or_else(|| file.path.clone()),
            ),
            _ => {
                self.notify("Uncommitted added lines cannot be blamed");
                return;
            }
        };
        let committed = matches!(file.source, FileSource::Commit(_));
        let line = if !committed && target.kind == DiffLineKind::Context {
            target.old_line.unwrap_or(target.line)
        } else {
            target.line
        };
        self.open_graph_menu(
            x,
            y,
            GraphMenuTarget {
                sha,
                file: Some(ChangedFile {
                    path,
                    original_path: file.original_path.clone(),
                    state: FileState::Modified,
                    staged: false,
                    unstaged: false,
                    submodule: None,
                }),
                file_staged: self.diff.staged(),
                line: usize::try_from(line).ok(),
                hunk_patch: hunk_for_menu(self, working, target),
                ..GraphMenuTarget::default()
            },
        );
    }

    /// Stages, unstages or reverts one hunk. Reverting asks first. `runHunkAction`.
    pub(crate) fn hunk_menu_action(&mut self, app: &App, action: GraphMenuAction, patch: String) {
        match action {
            GraphMenuAction::StageHunk => self.hunk_action(app, HunkAction::Stage, patch),
            GraphMenuAction::UnstageHunk => self.hunk_action(app, HunkAction::Unstage, patch),
            GraphMenuAction::RevertHunk => self.confirm_then(
                ConfirmRequest {
                    title: "Revert hunk".to_owned(),
                    lines: vec!["Discard this hunk's working-tree changes?".to_owned()],
                    confirm_label: "Revert hunk".to_owned(),
                    destructive: true,
                },
                move |shell, app| shell.hunk_action(app, HunkAction::Revert, patch),
            ),
            _ => {}
        }
    }
}

/// The hunk patch for the file menu, when the hunk entries are on.
fn hunk_for_menu(shell: &Shell, working: bool, target: DiffLineTarget) -> Option<String> {
    (working && DIFF_HUNK_MENU)
        .then(|| shell.hunk_patch_at(target.raw_row))
        .flatten()
}
