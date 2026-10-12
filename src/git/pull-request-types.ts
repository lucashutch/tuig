/** Shared pull request types for the `gh`-backed service and the UI. */

/** Whether a pull request is ready for review. */
export type PullRequestState = "open" | "draft";

/**
 * Combined status of every check on a pull request's head commit.
 *
 * The first matching rule wins:
 * - `failed`: any check failed, errored, was cancelled, timed out, or needs action.
 * - `running`: any check is in progress.
 * - `tentative`: at least one check passed and every started check passed, but
 *   some checks are queued, waiting, or requested and have not started.
 * - `passed`: every check finished and passed. Skipped and neutral count as passed.
 * - `pending`: checks exist but none has started or finished.
 * - `none`: the head commit has no checks.
 */
export type CheckRollup =
  | "failed"
  | "running"
  | "tentative"
  | "passed"
  | "pending"
  | "none";

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  checks: CheckRollup;
  author: string;
  /** Branch name in the head repository. */
  headBranch: string;
  /** Head commit SHA, when GitHub reports it. */
  headSha?: string;
  /** True when the head branch lives in a fork, so it cannot match a branch of this repository by name. */
  fromFork: boolean;
  /** True when the signed-in user wrote the pull request. */
  mine: boolean;
  /** True when the signed-in user, or a team they belong to, is asked to review. */
  reviewRequested: boolean;
  updatedAt: string;
}

/** Why pull requests are not shown. The UI hides the panel and column for every reason except `error`. */
export type PullRequestUnavailableReason =
  | "gh-missing"
  | "not-authenticated"
  | "not-github"
  | "error";

export type PullRequestList =
  | { available: true; pullRequests: readonly PullRequest[] }
  | {
      available: false;
      reason: PullRequestUnavailableReason;
      /** Short user-facing explanation, shown for `error`. */
      message?: string;
    };

/** Pull request access for one repository. */
export interface PullRequestService {
  /**
   * Every open pull request in the repository, newest first, with `mine` and
   * `reviewRequested` set. The sidebar shows those two groups. The history PR
   * column matches the rest to branches by `headBranch`.
   */
  list(signal?: AbortSignal): Promise<PullRequestList>;
}
