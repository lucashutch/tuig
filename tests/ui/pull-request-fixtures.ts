import type { PullRequest } from "../../src/git/pull-request-types.js";

/** An open, passing pull request from this repository, with overrides. */
export function pullRequest(
  number: number,
  overrides: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    title: `Change ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`,
    state: "open",
    checks: "passed",
    author: "someone",
    headBranch: `feature-${number}`,
    fromFork: false,
    mine: false,
    reviewRequested: false,
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}
