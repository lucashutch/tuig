//! The history graph. Ports `src/ui/runtime-history.ts` (selection, wheel batching, clicks), `loadMoreCommits` and
//! the history part of `refresh` in `src/ui/runtime-data.ts`, and the viewport and prefetch steps of
//! `paintHistory` in `src/ui/runtime-paint.ts`.

use crate::screens::history_columns::HistoryPointerState;
use crate::shell::{Dirty, GitResult, Msg, Shell};
use opentui::prelude::*;
use std::rc::Rc;
use std::time::Duration;
use tuig_git::debug_log::{debug_log, debug_log_error};
use tuig_git::repository::DEFAULT_HISTORY_PAGE;
use tuig_git::types::{Commit, CommitPage, RepositorySnapshot};
use tuig_ui_model::graph_index::GraphIndex;
use tuig_ui_model::graph_viewport::clamp_graph_scroll;
use tuig_ui_model::history_columns::{
    HistoryColumns, history_column_layout, visible_history_columns,
};
use tuig_ui_model::history_viewport::{
    HistorySelection, HistoryViewport, history_start_for_commit,
};
use tuig_ui_model::theme::Theme;
use tuig_widgets::branch_hints::BranchHintIndex;
use tuig_widgets::commit_text::short_sha;
use tuig_widgets::decorations::{RefIndex, primary_decoration_ref, resolve_head_sha};
use tuig_widgets::history::{ClickPart, HistorySource, HistoryWindow, history_window};

/// Commits per page. `HISTORY_PAGE` in `src/ui/runtime-data.ts`.
pub const HISTORY_PAGE: usize = DEFAULT_HISTORY_PAGE;
/// Failed pages in a row before paging stops asking. `HISTORY_PAGE_FAILURE_LIMIT`.
pub const HISTORY_PAGE_FAILURE_LIMIT: u32 = 3;
/// Wheel notches within this time scroll as one move. `queueHistoryScroll`.
pub const SCROLL_BATCH: Duration = Duration::from_millis(16);
/// Scrolling counts as stopped after this quiet time. `markHistoryScrolling`.
pub const SCROLL_SETTLE: Duration = Duration::from_millis(80);

/// Where a repository tab's history was when the user left the tab. `saveActiveTabHistory` in
/// `src/ui/runtime-tabs.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedHistory {
    /// First display row on screen.
    pub start: usize,
    /// The selected commit's SHA, to find it again when the commits changed. `None` for a working selection.
    pub selected_sha: Option<String>,
    /// The selected commit's index, used when the SHA is gone.
    pub commit_index: usize,
    pub selection: HistorySelection,
    pub detached: bool,
    /// How many commits to read, so the tab comes back as deep as it was.
    pub limit: usize,
}

pub struct HistoryState {
    /// Newest first. Paging appends to it in place.
    pub commits: Vec<Commit>,
    pub complete: bool,
    pub index: GraphIndex,
    pub refs: RefIndex,
    /// The nearest ref of each commit, shown on the selected row when it has no label.
    pub hints: BranchHintIndex,
    pub colors: Vec<String>,
    pub selection: HistorySelection,
    pub viewport: HistoryViewport,
    pub graph_scroll: usize,
    pub columns: HistoryColumns,
    /// Header separator and scrollbar drags.
    pub pointer: HistoryPointerState,
    /// Commits a refresh reads. Grows with each page. `historyLimit`.
    pub limit: usize,
    pub page_failures: u32,
    pub pending_scroll: i32,
    pub scroll_timer: Option<TimerId>,
    pub settle_timer: Option<TimerId>,
    /// True from a wheel notch until the settle timer fires. Graph avatars stay hidden meanwhile once they exist.
    pub scrolling: bool,
    /// The checked-out commit that a new repository selects once paging has loaded it. `focusCheckedOutCommit`.
    pub focus_sha: Option<String>,
    /// The window `sync` last gave the widget.
    pub window: Option<Rc<HistoryWindow>>,
    /// The position to restore once the first snapshot of a revisited tab has loaded.
    pub restore: Option<SavedHistory>,
}

impl HistoryState {
    pub fn new(theme: &Theme) -> Self {
        let colors: Vec<String> = theme.graph.iter().map(|color| color.to_hex()).collect();
        Self {
            commits: Vec::new(),
            complete: false,
            index: GraphIndex::new(None, &colors),
            refs: RefIndex::default(),
            hints: BranchHintIndex::default(),
            colors,
            selection: HistorySelection::Working,
            viewport: HistoryViewport::default(),
            graph_scroll: 0,
            columns: HistoryColumns {
                show_committer: true,
                show_sha: true,
                ..HistoryColumns::default()
            },
            pointer: HistoryPointerState::default(),
            limit: HISTORY_PAGE,
            page_failures: 0,
            pending_scroll: 0,
            scroll_timer: None,
            settle_timer: None,
            scrolling: false,
            focus_sha: None,
            window: None,
            restore: None,
        }
    }

    /// The position to keep while the user is in another tab.
    pub fn save(&self) -> SavedHistory {
        SavedHistory {
            start: self.viewport.start,
            selected_sha: self.selected_sha().map(str::to_owned),
            commit_index: self.selection.commit().unwrap_or(0),
            selection: self.selection,
            detached: self.viewport.detached,
            limit: self.limit,
        }
    }

    /// Puts a saved position back, once the commits are loaded. `restoreTabHistory`.
    fn restore_position(&mut self, saved: SavedHistory, total_rows: usize) {
        let found = saved
            .selected_sha
            .as_deref()
            .and_then(|sha| self.commits.iter().position(|commit| commit.sha == sha));
        let last = self.commits.len().saturating_sub(1);
        self.selection = match saved.selection {
            HistorySelection::Working => HistorySelection::Working,
            HistorySelection::Commit(_) => {
                HistorySelection::Commit(found.unwrap_or(saved.commit_index.min(last)))
            }
        };
        self.viewport.detached = saved.detached;
        self.viewport.start = saved.start.min(total_rows.saturating_sub(1));
    }

    pub fn selected_sha(&self) -> Option<&str> {
        let index = self.selection.commit()?;
        self.commits.get(index).map(|commit| commit.sha.as_str())
    }
}

impl Shell {
    pub(crate) fn has_working(&self) -> bool {
        self.snapshot
            .as_ref()
            .is_some_and(|snapshot| !snapshot.files.is_empty())
    }

    /// Display rows: the working row, if any, then one per loaded commit.
    pub(crate) fn history_total(&self) -> usize {
        self.history.commits.len() + usize::from(self.has_working())
    }

    pub(crate) fn selected_row(&self) -> usize {
        self.history.selection.row(self.has_working())
    }

    /// The source for [`history_window`]. `None` before the first snapshot.
    pub(crate) fn history_window(&mut self) -> Option<HistoryWindow> {
        let snapshot = self.snapshot.as_ref()?;
        let history = &mut self.history;
        let source = HistorySource {
            commits: &history.commits,
            branches: &snapshot.branches,
            refs: &history.refs,
            hints: &history.hints,
            colors: &history.colors,
            working_files: snapshot.files.len(),
            commits_complete: history.complete,
            pull_requests: self.pr.index.as_ref(),
            comparison_start: self.commands.comparison_start.as_deref(),
        };
        Some(history_window(
            &mut history.index,
            &source,
            history.viewport.start,
            self.layout.history_lines(),
        ))
    }

    pub(crate) fn start_snapshot(&mut self, app: &App) {
        let repo = self.repo.clone();
        let limit = self.history.limit;
        self.spawn(
            app,
            |tasks| &mut tasks.snapshot,
            async move { repo.snapshot(limit).await },
            Msg::Snapshot,
        );
    }

    pub(crate) fn snapshot_loaded(&mut self, app: &App, result: GitResult<RepositorySnapshot>) {
        match result {
            Ok(snapshot) => self.apply_snapshot(snapshot),
            Err(error) => self.notify_error(error.to_string()),
        }
        self.snapshot_finished(app);
    }

    /// Replaces the history with a new snapshot, keeping the selected commit when it is still there.
    fn apply_snapshot(&mut self, mut snapshot: RepositorySnapshot) {
        self.history.page_failures = 0;
        let first = self.snapshot.is_none();
        let commits = std::mem::take(&mut snapshot.commits);
        let same_history = self.snapshot.as_ref().is_some_and(|previous| {
            previous.branch == snapshot.branch
                && previous.branches == snapshot.branches
                && commits == self.history.commits
        });
        let head = resolve_head_sha(&snapshot.branches, &commits);
        let working_parent = head.clone().filter(|_| !snapshot.files.is_empty());
        if !same_history || self.history.index.working_parent_sha != working_parent {
            let history = &mut self.history;
            let selected = history.selected_sha().map(str::to_owned);
            // A page in flight extends the history this snapshot replaces.
            self.tasks.page.cancel();
            history.index = GraphIndex::new(working_parent.as_deref(), &history.colors);
            history
                .index
                .extend(&commits, &history.colors, head.as_deref())
                .expect("a new index takes any commit list");
            history.refs = RefIndex::new(&snapshot.branches);
            history.hints = BranchHintIndex::default();
            history.hints.extend(&commits, &snapshot.branches);
            if let HistorySelection::Commit(index) = history.selection {
                let found =
                    selected.and_then(|sha| commits.iter().position(|commit| commit.sha == sha));
                history.selection = HistorySelection::Commit(
                    found.unwrap_or_else(|| index.min(commits.len().saturating_sub(1))),
                );
            }
            history.commits = commits;
            history.complete = snapshot.commits_complete;
        }
        let restore = self.history.restore.take().filter(|_| first);
        if first && restore.is_none() {
            // `focusCheckedOutCommit`: with no HEAD the selection stays on the working row.
            self.history.focus_sha = snapshot.head_sha.clone().or(head);
        }
        let total_rows = self.history.commits.len() + usize::from(!snapshot.files.is_empty());
        self.snapshot = Some(snapshot);
        if let Some(saved) = restore {
            self.history.restore_position(saved, total_rows);
        }
        // The branches may have moved under the pull requests.
        self.rebuild_pull_request_index();
        self.dirty |= Dirty::HISTORY;
    }

    /// Reads the next page when the viewport nears the last loaded row. Ports `loadMoreCommits`: the page starts
    /// one commit early, and that commit must match the last loaded one, or refs moved and a refresh re-reads
    /// everything.
    fn load_more(&mut self, app: &App) {
        let history = &self.history;
        // A snapshot in flight carries the old limit and would cut the pages this read adds. `settle_history`
        // runs again when the snapshot lands, so the page starts then if the viewport still needs it.
        if self.snapshot.is_none()
            || history.complete
            || self.tasks.page.busy()
            || self.tasks.snapshot.busy()
            || history.page_failures >= HISTORY_PAGE_FAILURE_LIMIT
            || (history.focus_sha.is_none()
                && !history
                    .viewport
                    .wants_more(self.history_total(), self.layout.history_lines()))
        {
            return;
        }
        let repo = self.repo.clone();
        let loaded = history.commits.len();
        let (limit, skip) = if loaded == 0 {
            (HISTORY_PAGE, 0)
        } else {
            (HISTORY_PAGE + 1, loaded - 1)
        };
        self.spawn(
            app,
            |tasks| &mut tasks.page,
            async move { repo.commit_page(limit, skip).await },
            Msg::CommitPage,
        );
    }

    pub(crate) fn page_loaded(&mut self, app: &App, result: GitResult<CommitPage>) {
        let page = match result {
            Ok(page) => page,
            Err(error) => {
                // History on screen stays usable. Repeated failures stop paging.
                self.history.page_failures += 1;
                debug_log_error(
                    "history",
                    &format!(
                        "loading history past {} commits failed",
                        self.history.commits.len()
                    ),
                    &error,
                );
                self.notify_error(error.to_string());
                return;
            }
        };
        self.history.page_failures = 0;
        let history = &mut self.history;
        let last = history.commits.last();
        let aligned = match (last, page.commits.first()) {
            (None, _) => true,
            (Some(last), Some(overlap)) => {
                last.sha == overlap.sha && last.parents == overlap.parents
            }
            (Some(_), None) => false,
        };
        if !aligned {
            debug_log(
                "history",
                &format!(
                    "history diverged at {} commits; refreshing",
                    history.commits.len()
                ),
            );
            history.limit += HISTORY_PAGE;
            self.request_refresh(app, false);
            return;
        }
        let skip = usize::from(last.is_some());
        let fresh: Vec<Commit> = page.commits.into_iter().skip(skip).collect();
        let fresh_count = fresh.len();
        history.complete = page.complete || fresh.is_empty();
        history.commits.extend(fresh);
        history.limit = history.commits.len();
        if let Some(snapshot) = &self.snapshot {
            history.hints.extend(
                &history.commits[history.commits.len() - fresh_count..],
                &snapshot.branches,
            );
        }
        debug_log(
            "history",
            &format!(
                "appended {fresh_count} commits ({} loaded, complete={})",
                history.commits.len(),
                history.complete
            ),
        );
        let branches = self
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.branches.as_slice())
            .unwrap_or_default();
        let head = resolve_head_sha(branches, &history.commits);
        history
            .index
            .extend(&history.commits, &history.colors, head.as_deref())
            .expect("the commit list only grows");
        self.dirty |= Dirty::HISTORY;
    }

    /// Ports `moveCommit`. The viewport follows the selection again.
    pub(crate) fn move_commit(&mut self, delta: i64) {
        if self.snapshot.is_none() {
            return;
        }
        let has_working = self.has_working();
        let history = &mut self.history;
        history.viewport.detached = false;
        history.selection = history
            .selection
            .moved(delta, has_working, history.commits.len());
        self.dirty |= Dirty::HISTORY;
        // TS keeps the commit view on a working selection and paints stale details. Leave the view instead.
        if self.history.selection == HistorySelection::Working && self.commit_open() {
            self.close_details_for_working();
        }
    }

    /// Ports `historyClick` for a left press on a row. A commit row opens the details pane, and the working row
    /// closes it. A press on the short SHA copies it. A double click on a branch label checks the branch out, and
    /// on a tag or hint label it says so.
    pub(crate) fn history_click(&mut self, app: &App, row: usize, part: ClickPart, clicks: u8) {
        let has_working = self.has_working();
        let history = &mut self.history;
        history.pending_scroll = 0;
        history.viewport.detached = false;
        history.selection = HistorySelection::from_row(row, has_working);
        self.dirty |= Dirty::HISTORY;
        let HistorySelection::Commit(index) = self.history.selection else {
            return self.close_details_for_working();
        };
        let Some(commit) = self.history.commits.get(index).cloned() else {
            return;
        };
        if part == ClickPart::Sha {
            let sha = short_sha(&commit.sha).to_owned();
            if app.copy_to_clipboard(&sha) {
                self.notify(format!("Copied {sha}"));
            }
            return;
        }
        if clicks == 2 && part == ClickPart::Label {
            let branch = self.snapshot.as_ref().and_then(|snapshot| {
                primary_decoration_ref(&commit.decorations, &snapshot.branches, &self.history.refs)
                    .cloned()
            });
            return match branch {
                Some(branch) => self.checkout_branch(app, branch),
                None => self.notify("That label is a tag, not a branch"),
            };
        }
        self.open_commit();
    }

    /// Ports `queueHistoryScroll`: wheel notches add up for [`SCROLL_BATCH`] and then move the viewport once.
    pub(crate) fn queue_history_scroll(&mut self, app: &App, delta: i32) {
        self.history.pending_scroll += delta;
        self.mark_history_scrolling(app);
        if self.history.scroll_timer.is_some() {
            return;
        }
        let inbox = self.inbox.clone();
        self.history.scroll_timer = Some(app.set_timeout(SCROLL_BATCH, move |cx| {
            inbox.post(cx.app(), Msg::ScrollFlush)
        }));
    }

    /// Ports `markHistoryScrolling`.
    pub(crate) fn mark_history_scrolling(&mut self, app: &App) {
        self.history.scrolling = true;
        if let Some(timer) = self.history.settle_timer.take() {
            app.cancel_timer(timer);
        }
        let inbox = self.inbox.clone();
        self.history.settle_timer = Some(app.set_timeout(SCROLL_SETTLE, move |cx| {
            inbox.post(cx.app(), Msg::ScrollSettled)
        }));
    }

    pub(crate) fn flush_history_scroll(&mut self) {
        self.history.scroll_timer = None;
        let movement = std::mem::take(&mut self.history.pending_scroll);
        if self.snapshot.is_none() || movement == 0 {
            return;
        }
        let (total, lines, has_working) = (
            self.history_total(),
            self.layout.history_lines(),
            self.has_working(),
        );
        self.history
            .viewport
            .scroll(i64::from(movement), total, lines, has_working);
        self.dirty |= Dirty::HISTORY;
    }

    pub(crate) fn history_settled(&mut self) {
        self.history.settle_timer = None;
        self.history.scrolling = false;
        self.dirty |= Dirty::AVATARS;
    }

    /// Ports `scrollGraphColumns`. Returns false when the graph fits, so the key can do something else.
    pub(crate) fn scroll_graph(&mut self, delta: i64) -> bool {
        let width = self.layout.panes.history_content_width;
        let columns = visible_history_columns(self.history.columns, self.pr_column_available());
        let lanes = self.history.index.columns;
        let visible = history_column_layout(width, lanes, columns).graph_columns;
        if lanes <= visible {
            return false;
        }
        let next = clamp_graph_scroll(self.history.graph_scroll as i64 + delta, lanes, visible);
        if next != self.history.graph_scroll {
            self.history.graph_scroll = next;
            self.dirty |= Dirty::HISTORY;
        }
        true
    }

    /// Ports `focusCommit`: selects the commit and centers it once it is loaded. Until then `load_more` pages
    /// history. The wait ends when history is complete or paging gives up, and the selection stays as it is.
    pub(crate) fn focus_head(&mut self) {
        let Some(sha) = self.history.focus_sha.clone() else {
            return;
        };
        let history = &mut self.history;
        match history.commits.iter().position(|commit| commit.sha == sha) {
            Some(index) => {
                history.focus_sha = None;
                history.selection = HistorySelection::Commit(index);
                history.viewport.detached = false;
                let has_working = self.has_working();
                let lines = self.layout.history_lines();
                let history = &mut self.history;
                history.viewport.start =
                    history_start_for_commit(index, has_working, lines, history.commits.len());
                self.dirty |= Dirty::HISTORY;
            }
            None if history.complete || history.page_failures >= HISTORY_PAGE_FAILURE_LIMIT => {
                history.focus_sha = None;
            }
            None => {}
        }
    }

    /// Runs after every message: resolves the viewport as `paintHistory` does, then prefetches the next page.
    pub(crate) fn settle_history(&mut self, app: &App) {
        if self.snapshot.is_none() {
            return;
        }
        self.focus_head();
        let (selected, total, lines) = (
            self.selected_row(),
            self.history_total(),
            self.layout.history_lines(),
        );
        self.history.viewport.resolve(selected, total, lines);
        self.load_more(app);
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;
