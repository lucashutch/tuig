import { describe, expect, test } from "bun:test";
import type { CheckRollup } from "../../src/git/pull-request-types.js";
import {
  createPullRequestService,
  rollupChecks,
  type GhRunner,
} from "../../src/git/pull-requests.js";

const run = (conclusion: string | null, status = "COMPLETED") => ({
  __typename: "CheckRun",
  name: "build",
  status,
  conclusion,
});
const context = (state: string) => ({
  __typename: "StatusContext",
  context: "ci/external",
  state,
});

describe("rollupChecks", () => {
  const cases: [string, unknown[], CheckRollup][] = [
    ["no checks", [], "none"],
    ["all success", [run("SUCCESS"), run("SUCCESS")], "passed"],
    [
      "skipped and neutral count as passed",
      [run("SKIPPED"), run("NEUTRAL")],
      "passed",
    ],
    ["one failure", [run("SUCCESS"), run("FAILURE")], "failed"],
    ["cancelled", [run("CANCELLED")], "failed"],
    ["timed out", [run("TIMED_OUT")], "failed"],
    ["action required", [run("ACTION_REQUIRED")], "failed"],
    ["stale", [run("STALE")], "failed"],
    ["startup failure", [run("STARTUP_FAILURE")], "failed"],
    [
      "failed beats running",
      [run(null, "IN_PROGRESS"), run("FAILURE")],
      "failed",
    ],
    ["failed beats queued", [run(null, "QUEUED"), run("FAILURE")], "failed"],
    [
      "running beats tentative",
      [run("SUCCESS"), run(null, "QUEUED"), run(null, "IN_PROGRESS")],
      "running",
    ],
    [
      "passed plus queued is tentative",
      [run("SUCCESS"), run(null, "QUEUED")],
      "tentative",
    ],
    [
      "passed plus waiting is tentative",
      [run("NEUTRAL"), run(null, "WAITING")],
      "tentative",
    ],
    [
      "passed plus requested is tentative",
      [run("SUCCESS"), run(null, "REQUESTED")],
      "tentative",
    ],
    [
      "all queued is pending",
      [run(null, "QUEUED"), run(null, "PENDING")],
      "pending",
    ],
    [
      "unknown in-flight status counts as running",
      [run("SUCCESS"), run(null, "SOMETHING_NEW")],
      "running",
    ],
    ["unknown conclusion counts as failed", [run("SOMETHING_NEW")], "failed"],
    ["completed without conclusion counts as failed", [run(null)], "failed"],
    ["status context success", [context("SUCCESS")], "passed"],
    ["status context failure", [context("FAILURE")], "failed"],
    ["status context error", [context("ERROR")], "failed"],
    [
      "status context pending counts as running",
      [run("SUCCESS"), context("PENDING")],
      "running",
    ],
    [
      "status context expected counts as queued",
      [context("EXPECTED")],
      "pending",
    ],
    [
      "status context expected after a pass is tentative",
      [run("SUCCESS"), context("EXPECTED")],
      "tentative",
    ],
    [
      "malformed items are ignored",
      [null, 7, "x", {}, { __typename: "CheckRun" }],
      "none",
    ],
  ];
  test.each(cases)("%s", (_name, contexts, expected) => {
    expect(rollupChecks(contexts)).toBe(expected);
  });
});

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1) => ({
  stdout: "",
  stderr,
  exitCode,
});

const listJson = JSON.stringify([
  {
    number: 12,
    title: "Older draft",
    url: "https://github.com/acme/app/pull/12",
    isDraft: true,
    author: { login: "Lucashutch", is_bot: false },
    headRefName: "draft-work",
    headRefOid: "aaa111",
    headRepositoryOwner: { login: "acme" },
    isCrossRepository: false,
    updatedAt: "2026-10-01T10:00:00Z",
    statusCheckRollup: [],
  },
  {
    number: 15,
    title: "Fork change",
    url: "https://github.com/acme/app/pull/15",
    isDraft: false,
    author: { login: "outsider" },
    headRefName: "patch-1",
    headRefOid: "bbb222",
    headRepositoryOwner: { login: "outsider" },
    isCrossRepository: true,
    updatedAt: "2026-10-05T10:00:00Z",
    statusCheckRollup: [
      run("SUCCESS"),
      { __typename: "StatusContext", context: "ci", state: "PENDING" },
    ],
  },
  { number: "bad", title: 3 },
  null,
]);

function fakeGh(handlers: {
  list?: () => ReturnType<GhRunner>;
  review?: () => ReturnType<GhRunner>;
  login?: () => ReturnType<GhRunner>;
}) {
  const calls: string[][] = [];
  const runner: GhRunner = async (args, options) => {
    calls.push(args);
    expect(options.cwd).toBe("/repo");
    if (args[0] === "api")
      return (handlers.login ?? (() => ok("lucashutch\n")))();
    if (args.includes("--search"))
      return (handlers.review ?? (() => ok('[{"number":15}]')))();
    return (handlers.list ?? (() => ok(listJson)))();
  };
  return { runner, calls };
}

describe("pull request service", () => {
  test("lists open pull requests newest first with mine, review, and fork flags", async () => {
    const { runner, calls } = fakeGh({});
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
          author: "Lucashutch",
          headBranch: "draft-work",
          headSha: "aaa111",
          fromFork: false,
          mine: true,
          reviewRequested: false,
          updatedAt: "2026-10-01T10:00:00Z",
        },
      ],
    });
    expect(calls).toContainEqual([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,isDraft,author,headRefName,headRefOid,headRepositoryOwner,isCrossRepository,updatedAt,statusCheckRollup",
    ]);
  });

  test("asks for the signed-in login once per service", async () => {
    const { runner, calls } = fakeGh({});
    const service = createPullRequestService("/repo", { runner });
    await service.list();
    await service.list();
    expect(calls.filter((args) => args[0] === "api")).toHaveLength(1);
  });

  test("keeps the list when the review-requested search fails", async () => {
    const { runner } = fakeGh({
      review: async () => fail("HTTP 502: Bad Gateway"),
    });
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
    const { runner, calls } = fakeGh({
      list: async () => {
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      },
      review: async () => {
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      },
      login: async () => {
        throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      },
    });
    const service = createPullRequestService("/repo", { runner });
    expect(await service.list()).toEqual({
      available: false,
      reason: "gh-missing",
    });
    const before = calls.length;
    expect(await service.list()).toEqual({
      available: false,
      reason: "gh-missing",
    });
    expect(calls).toHaveLength(before);
  });

  test("reports not-authenticated and retries on the next list", async () => {
    const stderr =
      "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n";
    let loggedIn = false;
    const { runner } = fakeGh({
      list: async () => (loggedIn ? ok(listJson) : fail(stderr, 4)),
      review: async () => (loggedIn ? ok("[]") : fail(stderr, 4)),
      login: async () => (loggedIn ? ok("lucashutch") : fail(stderr, 4)),
    });
    const service = createPullRequestService("/repo", {
      runner,
      now: () => 1_000_000,
    });
    expect(await service.list()).toEqual({
      available: false,
      reason: "not-authenticated",
    });
    loggedIn = true;
    expect((await service.list()).available).toBe(true);
  });

  test("reports not-github even though gh suggests logging in", async () => {
    const stderr =
      "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n";
    const { runner, calls } = fakeGh({
      list: async () => fail(stderr),
      review: async () => fail(stderr),
      login: async () => fail(stderr),
    });
    const service = createPullRequestService("/repo", { runner });
    expect(await service.list()).toEqual({
      available: false,
      reason: "not-github",
    });
    const before = calls.length;
    await service.list();
    expect(calls).toHaveLength(before);
  });

  test("reports other failures with a short message", async () => {
    const { runner } = fakeGh({
      list: async () =>
        fail("GraphQL: Resource not accessible\nsecond line\n", 1),
    });
    expect(await createPullRequestService("/repo", { runner }).list()).toEqual({
      available: false,
      reason: "error",
      message: "GraphQL: Resource not accessible",
    });
  });

  test("reports an error for malformed JSON", async () => {
    const { runner } = fakeGh({ list: async () => ok("{not json") });
    const result = await createPullRequestService("/repo", { runner }).list();
    expect(result).toMatchObject({ available: false, reason: "error" });
  });

  test("throws when the caller aborts", async () => {
    const controller = new AbortController();
    const { runner } = fakeGh({
      list: async () => {
        controller.abort();
        throw new Error("killed");
      },
    });
    await expect(
      createPullRequestService("/repo", { runner }).list(controller.signal),
    ).rejects.toThrow();
  });
});
