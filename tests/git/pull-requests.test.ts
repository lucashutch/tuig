import { describe, expect, test } from "bun:test";
import type { CheckRollup } from "../../src/git/pull-request-types.js";
import {
  createPullRequestService,
  rollupCheckCounts,
  type GhRunner,
} from "../../src/git/pull-requests.js";

const counts = (states: string[]) =>
  states.map((state) => ({ state, count: 1 }));
const runs = (...states: string[]) => ({
  checkRunCountsByState: counts(states),
  statusContextCountsByState: [],
});
const statuses = (...states: string[]) => ({
  checkRunCountsByState: [],
  statusContextCountsByState: counts(states),
});
const both = (checkRuns: string[], contexts: string[]) => ({
  checkRunCountsByState: counts(checkRuns),
  statusContextCountsByState: counts(contexts),
});

describe("rollupCheckCounts", () => {
  const cases: [string, unknown, CheckRollup][] = [
    ["no rollup", undefined, "none"],
    ["no checks", runs(), "none"],
    [
      "zero counts are ignored",
      {
        checkRunCountsByState: [
          { state: "FAILURE", count: 0 },
          { state: "SUCCESS", count: 2 },
        ],
      },
      "passed",
    ],
    [
      "skipped and neutral count as passed",
      runs("SKIPPED", "NEUTRAL"),
      "passed",
    ],
    ["one failure", runs("SUCCESS", "FAILURE"), "failed"],
    ["cancelled", runs("CANCELLED"), "failed"],
    ["timed out", runs("TIMED_OUT"), "failed"],
    ["action required", runs("ACTION_REQUIRED"), "failed"],
    ["stale", runs("STALE"), "failed"],
    ["startup failure", runs("STARTUP_FAILURE"), "failed"],
    [
      "completed without conclusion counts as failed",
      runs("COMPLETED"),
      "failed",
    ],
    ["failed beats running", runs("IN_PROGRESS", "FAILURE"), "failed"],
    ["failed beats queued", runs("QUEUED", "FAILURE"), "failed"],
    [
      "running beats tentative",
      runs("SUCCESS", "QUEUED", "IN_PROGRESS"),
      "running",
    ],
    ["passed plus queued is tentative", runs("SUCCESS", "QUEUED"), "tentative"],
    [
      "passed plus waiting is tentative",
      runs("NEUTRAL", "WAITING"),
      "tentative",
    ],
    [
      "passed plus requested is tentative",
      runs("SUCCESS", "REQUESTED"),
      "tentative",
    ],
    ["all queued is pending", runs("QUEUED", "PENDING"), "pending"],
    [
      "unknown state never counts as passed",
      runs("SUCCESS", "SOMETHING_NEW"),
      "running",
    ],
    ["status context success", statuses("SUCCESS"), "passed"],
    ["status context failure", statuses("FAILURE"), "failed"],
    ["status context error", statuses("ERROR"), "failed"],
    [
      "status context pending counts as running",
      both(["SUCCESS"], ["PENDING"]),
      "running",
    ],
    [
      "status context expected counts as queued",
      statuses("EXPECTED"),
      "pending",
    ],
    [
      "status context expected after a pass is tentative",
      both(["SUCCESS"], ["EXPECTED"]),
      "tentative",
    ],
    [
      "malformed entries are ignored",
      {
        checkRunCountsByState: [null, 7, { state: "FAILURE" }, { count: 3 }],
        statusContextCountsByState: "x",
      },
      "none",
    ],
  ];
  test.each(cases)("%s", (_name, contexts, expected) => {
    expect(rollupCheckCounts(contexts)).toBe(expected);
  });
});

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1, stdout = "") => ({
  stdout,
  stderr,
  exitCode,
});

const listData = {
  viewer: { login: "Lucashutch" },
  repository: {
    pullRequests: {
      nodes: [
        {
          number: 12,
          title: "Older draft",
          url: "https://github.com/acme/app/pull/12",
          isDraft: true,
          author: { login: "lucashutch" },
          headRefName: "draft-work",
          headRefOid: "aaa111",
          isCrossRepository: false,
          updatedAt: "2026-10-01T10:00:00Z",
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        },
        {
          number: 15,
          title: "Fork change",
          url: "https://github.com/acme/app/pull/15",
          isDraft: false,
          author: { login: "outsider" },
          headRefName: "patch-1",
          headRefOid: "bbb222",
          isCrossRepository: true,
          updatedAt: "2026-10-05T10:00:00Z",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: both(["SUCCESS"], ["PENDING"]),
                  },
                },
              },
            ],
          },
        },
        { number: "bad", title: 3 },
        null,
      ],
    },
  },
  review: { nodes: [{ number: 15 }, {}] },
};
const listJson = JSON.stringify({ data: listData });

function fakeGh(answer: () => ReturnType<GhRunner> = async () => ok(listJson)) {
  const calls: string[][] = [];
  const runner: GhRunner = async (args, options) => {
    calls.push(args);
    expect(options.cwd).toBe("/repo");
    return answer();
  };
  return { runner, calls };
}

describe("pull request service", () => {
  test("lists open pull requests newest first with mine, review, and fork flags", async () => {
    const { runner, calls } = fakeGh();
    const result = await createPullRequestService("/repo", {
      runner,
    }).list();
    expect(result).toEqual({
      available: true,
      pullRequests: [
        {
          number: 15,
          title: "Fork change",
          url: "https://github.com/acme/app/pull/15",
          state: "open",
          checks: "running",
          author: "outsider",
          headBranch: "patch-1",
          headSha: "bbb222",
          fromFork: true,
          mine: false,
          reviewRequested: true,
          updatedAt: "2026-10-05T10:00:00Z",
        },
        {
          number: 12,
          title: "Older draft",
          url: "https://github.com/acme/app/pull/12",
          state: "draft",
          checks: "none",
          author: "lucashutch",
          headBranch: "draft-work",
          headSha: "aaa111",
          fromFork: false,
          mine: true,
          reviewRequested: false,
          updatedAt: "2026-10-01T10:00:00Z",
        },
      ],
    });
    // One request lists pull requests, the login, and review requests.
    expect(calls).toHaveLength(1);
  });

  test("keeps the list when the review-requested search fails", async () => {
    const { runner } = fakeGh(async () =>
      fail(
        "gh: Something went wrong while executing your query.\n",
        1,
        JSON.stringify({ data: { ...listData, review: null } }),
      ),
    );
    const result = await createPullRequestService("/repo", {
      runner,
    }).list();
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.pullRequests.map((pr) => pr.reviewRequested)).toEqual([
      false,
      false,
    ]);
  });

  test("reports gh-missing and does not run gh again", async () => {
    const { runner, calls } = fakeGh(async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    });
    const service = createPullRequestService("/repo", { runner });
    expect(await service.list()).toEqual({
      available: false,
      reason: "gh-missing",
    });
    expect(await service.list()).toEqual({
      available: false,
      reason: "gh-missing",
    });
    expect(calls).toHaveLength(1);
  });

  test("reports not-authenticated and retries on the next list", async () => {
    let loggedIn = false;
    const { runner } = fakeGh(async () =>
      loggedIn ? ok(listJson) : fail("gh: Bad credentials (HTTP 401)\n"),
    );
    const service = createPullRequestService("/repo", { runner });
    expect(await service.list()).toEqual({
      available: false,
      reason: "not-authenticated",
    });
    loggedIn = true;
    expect((await service.list()).available).toBe(true);
  });

  test("reports not-github even though gh suggests logging in", async () => {
    const stderr =
      'error parsing "owner" value: none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n';
    const { runner, calls } = fakeGh(async () => fail(stderr));
    const service = createPullRequestService("/repo", { runner });
    expect(await service.list()).toEqual({
      available: false,
      reason: "not-github",
    });
    await service.list();
    expect(calls).toHaveLength(1);
  });

  test("reports other failures with a short message", async () => {
    const { runner } = fakeGh(async () =>
      fail(
        "gh: Could not resolve to a Repository with the name 'acme/app'.\nsecond line\n",
        1,
        JSON.stringify({ data: { repository: null } }),
      ),
    );
    expect(await createPullRequestService("/repo", { runner }).list()).toEqual({
      available: false,
      reason: "error",
      message:
        "gh: Could not resolve to a Repository with the name 'acme/app'.",
    });
  });

  test("reports an error for malformed JSON", async () => {
    const { runner } = fakeGh(async () => ok("{not json"));
    const result = await createPullRequestService("/repo", { runner }).list();
    expect(result).toMatchObject({ available: false, reason: "error" });
  });

  test("throws when the caller aborts", async () => {
    const controller = new AbortController();
    const { runner } = fakeGh(async () => {
      controller.abort();
      throw new Error("killed");
    });
    await expect(
      createPullRequestService("/repo", { runner }).list(controller.signal),
    ).rejects.toThrow();
  });
});
