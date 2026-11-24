//! Shared pull request types and the `PullRequestService` contract.
//! Port of `src/git/pull-request-types.ts`.

use async_trait::async_trait;

use crate::process::CancelToken;

/// Whether a pull request is ready for review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestState {
    Open,
    Draft,
}

/// Combined status of every check on a pull request's head commit.
///
/// The first matching rule wins:
/// - `Failed`: any check failed, errored, was cancelled, timed out, or needs action.
/// - `Running`: any check is in progress.
/// - `Tentative`: at least one check passed and every started check passed, but
///   some checks are queued, waiting, or requested and have not started.
/// - `Passed`: every check finished and passed. Skipped and neutral count as passed.
/// - `Pending`: checks exist but none has started or finished.
/// - `None`: the head commit has no checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckRollup {
    Failed,
    Running,
    Tentative,
    Passed,
    Pending,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: PullRequestState,
    pub checks: CheckRollup,
    pub author: String,
    /// Branch name in the head repository.
    pub head_branch: String,
    /// Head commit SHA, when GitHub reports it.
    pub head_sha: Option<String>,
    /// True when the head branch lives in a fork, so it cannot match a branch
    /// of this repository by name.
    pub from_fork: bool,
    /// True when the signed-in user wrote the pull request.
    pub mine: bool,
    /// True when the signed-in user, or a team they belong to, is asked to review.
    pub review_requested: bool,
    pub updated_at: String,
}

/// Why pull requests are not shown. The UI hides the panel and column for
/// every reason except `Error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestUnavailableReason {
    GhMissing,
    NotAuthenticated,
    NotGithub,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PullRequestList {
    Available {
        pull_requests: Vec<PullRequest>,
    },
    Unavailable {
        reason: PullRequestUnavailableReason,
        /// Short user-facing explanation, shown for `Error`.
        message: Option<String>,
    },
}

/// Pull request access for one repository.
#[async_trait]
pub trait PullRequestService: Send + Sync {
    /// Every open pull request in the repository, newest first, with `mine`
    /// and `review_requested` set. The sidebar shows those two groups. The
    /// history PR column matches the rest to branches by `head_branch`.
    async fn list(&self, cancel: Option<&CancelToken>) -> PullRequestList;
}
