//! Pull requests for the history column. Ports the loading, refresh timing and spinner parts of
//! `src/ui/runtime-pull-requests.ts`.
//!
//! The list comes from `gh` through a [`PullRequestService`]. It loads at start, then again after
//! [`ACTIVE_REFRESH`] while any check can still change, or [`IDLE_REFRESH`] when every check has settled. The old
//! list stays on screen until the new answer arrives. A failure replaces it, so a signed-out `gh` hides the column.
//!
//! The spinner for running checks runs while a visible history or sidebar row shows one, so no timer runs when
//! nothing animates. The sidebar panel, `select`, `open` and `openForCurrentBranch` are in `screens/sidebar.rs`.
//! Their pure parts are in `tuig_widgets::pull_requests`.

use crate::services::UrlOpener;
use crate::shell::{Dirty, Msg, Shell};
use opentui::prelude::*;
use std::sync::Arc;
use std::time::Duration;
use tuig_git::pull_request_types::{PullRequest, PullRequestList, PullRequestService};
use tuig_widgets::pull_requests::{
    PullRequestCommitIndex, SPINNER_FRAMES, is_unsettled, pull_request_branch,
    pull_request_commit_index,
};

/// Re-list interval while some check can still change. `PULL_REQUEST_ACTIVE_REFRESH_MS`.
pub const ACTIVE_REFRESH: Duration = Duration::from_secs(60);
/// Re-list interval while every check has settled. `PULL_REQUEST_IDLE_REFRESH_MS`.
pub const IDLE_REFRESH: Duration = Duration::from_secs(180);
/// Time between spinner frames. `BRAILLE_SPINNER_INTERVAL_MS`.
pub const SPINNER_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct PullRequestsState {
    /// `None` turns the feature off.
    pub service: Option<Arc<dyn PullRequestService>>,
    /// Opens a pull request's page. `None` leaves the browser alone.
    pub opener: Option<Arc<dyn UrlOpener>>,
    pub result: Option<PullRequestList>,
    /// Row matcher for the history column. `None` while the list is empty or unavailable.
    pub index: Option<PullRequestCommitIndex>,
    pub(crate) refresh_timer: Option<TimerId>,
    pub(crate) spinner_timer: Option<TimerId>,
    /// Index into [`SPINNER_FRAMES`].
    pub spinner_frame: usize,
}

impl PullRequestsState {
    pub fn new(
        service: Option<Arc<dyn PullRequestService>>,
        opener: Option<Arc<dyn UrlOpener>>,
    ) -> Self {
        Self {
            service,
            opener,
            ..Self::default()
        }
    }

    /// Every open pull request, or none while the list is unavailable. `pullRequests`.
    pub fn pull_requests(&self) -> &[PullRequest] {
        match &self.result {
            Some(PullRequestList::Available { pull_requests }) => pull_requests,
            _ => &[],
        }
    }
}

fn refresh_delay(result: &PullRequestList) -> Duration {
    match result {
        PullRequestList::Available { pull_requests }
            if pull_requests.iter().any(|pr| is_unsettled(pr.checks)) =>
        {
            ACTIVE_REFRESH
        }
        _ => IDLE_REFRESH,
    }
}

impl Shell {
    /// Whether the history PR column has data to show. `columnAvailable`.
    pub(crate) fn pr_column_available(&self) -> bool {
        self.pr.index.is_some()
    }

    /// Builds the row matcher from the list and the current branches. `columnIndex`.
    pub(crate) fn rebuild_pull_request_index(&mut self) {
        let branches = self
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.branches.as_slice());
        let pull_requests = self.pr.pull_requests();
        self.pr.index = match branches {
            Some(branches) if !pull_requests.is_empty() => {
                Some(pull_request_commit_index(pull_requests, branches))
            }
            _ => None,
        };
    }

    /// Starts the first load. `activate`.
    pub(crate) fn start_pull_requests(&mut self, app: &App) {
        self.load_pull_requests(app);
    }

    /// Lists pull requests now and keeps the current list on screen until the answer. `refresh`.
    pub(crate) fn load_pull_requests(&mut self, app: &App) {
        let Some(service) = self.pr.service.clone() else {
            return;
        };
        if let Some(timer) = self.pr.refresh_timer.take() {
            app.cancel_timer(timer);
        }
        self.spawn(
            app,
            |tasks| &mut tasks.pull_requests,
            async move { service.list(None).await },
            Msg::PullRequests,
        );
    }

    /// The open pull request whose head is the checked-out branch, newest first. `forCurrentBranch`.
    pub(crate) fn pull_request_for_current_branch(&self) -> Option<&PullRequest> {
        let snapshot = self.snapshot.as_ref()?;
        let current = snapshot
            .branches
            .iter()
            .find(|branch| branch.current && !branch.remote);
        let mut candidates: Vec<&PullRequest> = self.pr.pull_requests().iter().collect();
        candidates.sort_by_key(|pr| std::cmp::Reverse(pr.number));
        candidates.into_iter().find(|pr| {
            current.is_some_and(|current| {
                pull_request_branch(pr, &snapshot.branches).is_some_and(|branch| branch == current)
            }) || (pr.head_sha.is_some() && pr.head_sha == snapshot.head_sha)
        })
    }

    pub(crate) fn pull_requests_loaded(&mut self, app: &App, result: PullRequestList) {
        let delay = refresh_delay(&result);
        self.pr.result = Some(result);
        self.rebuild_pull_request_index();
        let inbox = self.inbox.clone();
        self.pr.refresh_timer =
            Some(app.set_timeout(delay, move |cx| inbox.post(cx.app(), Msg::PullRequestsDue)));
        self.dirty |= Dirty::HISTORY;
    }

    pub(crate) fn pull_requests_due(&mut self, app: &App) {
        self.pr.refresh_timer = None;
        self.load_pull_requests(app);
    }

    /// Starts or stops the spinner timer so it runs only while a visible row shows running checks. `spinnerShown`.
    pub(crate) fn sync_spinner(&mut self, app: &App) {
        let in_history =
            !self.diff.is_open()
                && self.history.window.as_ref().is_some_and(|window| {
                    window.running_checks_visible(self.layout.history_lines())
                });
        // The sidebar's spinner stops with the sidebar. `spinnerShown`.
        let in_sidebar = self.sidebar.running_checks && !self.layout.left_collapsed;
        let running = in_history || in_sidebar;
        match (running, self.pr.spinner_timer) {
            (true, None) => {
                self.pr.spinner_frame = 0;
                let inbox = self.inbox.clone();
                self.pr.spinner_timer = Some(app.set_interval(SPINNER_INTERVAL, move |cx| {
                    inbox.post(cx.app(), Msg::SpinnerTick)
                }));
            }
            (false, Some(timer)) => {
                app.cancel_timer(timer);
                self.pr.spinner_timer = None;
                self.pr.spinner_frame = 0;
            }
            _ => {}
        }
    }

    pub(crate) fn spinner_tick(&mut self) {
        // A tick already queued when the timer stopped must not restart the animation.
        if self.pr.spinner_timer.is_none() {
            return;
        }
        self.pr.spinner_frame = (self.pr.spinner_frame + 1) % SPINNER_FRAMES.len();
    }
}

#[cfg(test)]
#[path = "pull_requests_tests.rs"]
mod tests;
