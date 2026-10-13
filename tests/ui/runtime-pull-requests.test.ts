import { describe, expect, test } from "bun:test";
import { MouseButton } from "@opentui/core";
import type {
  PullRequestList,
  PullRequestService,
} from "../../src/git/pull-request-types.js";
import type { BranchRef, RepositorySnapshot } from "../../src/git/types.js";
import {
  PULL_REQUEST_ACTIVE_REFRESH_MS,
  PULL_REQUEST_AFTER_SYNC_MS,
  PULL_REQUEST_IDLE_REFRESH_MS,
  RuntimePullRequestsController,
  type PullRequestTimers,
  type RuntimePullRequestsContext,
} from "../../src/ui/runtime-pull-requests.js";
import {
  sidebarClick,
  type RuntimeSidebarContext,
} from "../../src/ui/runtime-sidebar.js";
import {
  layoutSidebarSections,
  sidebarHiddenSections,
  SIDEBAR_SECTIONS,
  type SidebarSection,
} from "../../src/ui/runtime-presentation.js";
import { pullRequest } from "./pull-request-fixtures.js";

function fakeTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const timers: PullRequestTimers = {
    set: (callback, ms) => {
      pending.set(++next, { callback, ms });
      return next;
    },
    clear: (handle) => pending.delete(handle as number),
  };
  return {
    timers,
    delays: () => [...pending.values()].map((entry) => entry.ms),
    fire: () => {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.callback();
    },
  };
}

/** A service whose answers the test releases one at a time. */
function controlledService() {
  const calls: Array<{
    signal?: AbortSignal;
    resolve: (list: PullRequestList) => void;
  }> = [];
  const service: PullRequestService = {
    list: (signal) => new Promise((resolve) => calls.push({ signal, resolve })),
  };
  return { service, calls };
}

const ref = (name: string, sha: string, remote = false): BranchRef => ({
  name,
  fullName: remote ? `refs/remotes/${name}` : `refs/heads/${name}`,
  sha,
  current: false,
  remote,
});

function snapshot(
  branches: BranchRef[] = [],
  commits: string[] = [],
): RepositorySnapshot {
  return {
    root: "/repo",
    ahead: 0,
    behind: 0,
    files: [],
    branches,
    stashes: [],
    worktrees: [],
    submodules: [],
    commits: commits.map((sha) => ({
      sha,
      parents: [],
      author: "",
      authorEmail: "",
      authoredAt: "",
      committer: "",
      committerEmail: "",
      committedAt: "",
      subject: "",
      decorations: [],
    })),
    commitsComplete: true,
  };
}

function makeController(
  services: Record<string, PullRequestService>,
  options: { snapshot?: RepositorySnapshot; now?: () => number } = {},
) {
  const clock = fakeTimers();
  const events = {
    focused: [] as string[],
    opened: [] as string[],
    notes: [] as string[],
    paints: 0,
  };
  const context: RuntimePullRequestsContext = {
    repository: { root: "/a" },
    snapshot: options.snapshot ?? snapshot(),
    leftCollapsed: false,
    paintSidebar: () => events.paints++,
    paintHistory: () => undefined,
    notify: (text) => events.notes.push(text),
    focusCommit: async (sha) => {
      events.focused.push(sha);
      return true;
    },
  };
  const controller = new RuntimePullRequestsController(context, {
    factory: (root) => services[root]!,
    timers: clock.timers,
    now: options.now,
    openUrl: async (url) => {
      events.opened.push(url);
    },
  });
  return { controller, context, clock, events };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pull request refresh", () => {
  test("re-lists every minute while checks can change, else every three minutes", async () => {
    const { service, calls } = controlledService();
    const { controller, clock } = makeController({ "/a": service });
    controller.activate();
    calls[0]!.resolve({
      available: true,
      pullRequests: [pullRequest(1, { checks: "running" })],
    });
    await flush();
    expect(clock.delays()).toEqual([PULL_REQUEST_ACTIVE_REFRESH_MS]);

    clock.fire();
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({
      available: true,
      pullRequests: [pullRequest(1, { checks: "passed" })],
    });
    await flush();
    expect(clock.delays()).toEqual([PULL_REQUEST_IDLE_REFRESH_MS]);

    clock.fire();
    calls[2]!.resolve({
      available: true,
      pullRequests: [pullRequest(1, { checks: "tentative" })],
    });
    await flush();
    expect(clock.delays()).toEqual([PULL_REQUEST_ACTIVE_REFRESH_MS]);
  });

  test("a push or fetch brings the next re-list forward", async () => {
    const { service, calls } = controlledService();
    const { controller, clock } = makeController({ "/a": service });
    controller.activate();
    calls[0]!.resolve({ available: true, pullRequests: [] });
    await flush();
    controller.refreshSoon();
    expect(clock.delays()).toEqual([PULL_REQUEST_AFTER_SYNC_MS]);
    clock.fire();
    expect(calls).toHaveLength(2);
  });

  test("an answer for the previous tab never replaces the new tab's list", async () => {
    const first = controlledService();
    const second = controlledService();
    const { controller, context } = makeController({
      "/a": first.service,
      "/b": second.service,
    });
    controller.activate();
    (context as { repository: { root: string } }).repository = { root: "/b" };
    controller.activate();
    expect(first.calls[0]!.signal?.aborted).toBe(true);

    first.calls[0]!.resolve({
      available: true,
      pullRequests: [pullRequest(1, { mine: true })],
    });
    await flush();
    expect(controller.panel).toEqual({ kind: "loading" });

    second.calls[0]!.resolve({
      available: true,
      pullRequests: [pullRequest(2, { mine: true })],
    });
    await flush();
    const panel = controller.panel;
    expect(panel.kind === "list" && panel.pullRequests[0]!.number).toBe(2);
  });

  test("switching back to a tab shows its last list and re-lists only when due", async () => {
    const first = controlledService();
    const second = controlledService();
    let now = 0;
    const { controller, context, clock } = makeController(
      { "/a": first.service, "/b": second.service },
      { now: () => now },
    );
    const switchTo = (root: string) => {
      (context as { repository: { root: string } }).repository = { root };
      controller.activate();
    };
    controller.activate();
    first.calls[0]!.resolve({
      available: true,
      pullRequests: [pullRequest(1, { mine: true })],
    });
    await flush();
    switchTo("/b");
    now = 60_000;
    switchTo("/a");

    const panel = controller.panel;
    expect(panel.kind === "list" && panel.pullRequests[0]!.number).toBe(1);
    expect(first.calls).toHaveLength(1);
    expect(clock.delays()).toEqual([PULL_REQUEST_IDLE_REFRESH_MS - 60_000]);
    clock.fire();
    expect(first.calls).toHaveLength(2);
  });

  test("a failed list shows its message", async () => {
    const { controller } = makeController({
      "/a": {
        list: async () => {
          throw new Error("gh exploded");
        },
      },
    });
    controller.activate();
    await flush();
    expect(controller.panel).toEqual({ kind: "message", text: "gh exploded" });
  });

  test("without a service factory the feature stays hidden", () => {
    const controller = new RuntimePullRequestsController({
      repository: { root: "/a" },
      leftCollapsed: false,
      paintSidebar: () => undefined,
      paintHistory: () => undefined,
      notify: () => undefined,
      focusCommit: async () => true,
    });
    controller.activate();
    expect(controller.panel).toEqual({ kind: "hidden" });
    expect(controller.columnAvailable).toBe(false);
  });
});

describe("pull request selection", () => {
  test("selects the head branch, then the head commit, else explains", async () => {
    const { controller, events } = makeController(
      {},
      {
        snapshot: snapshot(
          [ref("feature-1", "branch-tip"), ref("origin/feature-2", "r2", true)],
          ["fork-head"],
        ),
      },
    );
    await controller.select(pullRequest(1, { headSha: "fork-head" }));
    await controller.select(pullRequest(2));
    await controller.select(
      pullRequest(3, {
        fromFork: true,
        headBranch: "feature-1",
        headSha: "fork-head",
      }),
    );
    await controller.select(pullRequest(66, { headSha: "not-loaded" }));
    expect(events.focused).toEqual(["branch-tip", "r2", "fork-head"]);
    expect(events.notes).toEqual(["Branch for #66 is not fetched"]);
  });
});

describe("pull request sidebar clicks", () => {
  test("a click selects without checkout and a double click opens the page", async () => {
    const { service, calls } = controlledService();
    const { controller, events } = makeController(
      { "/a": service },
      { snapshot: snapshot([ref("feature-7", "tip7")]) },
    );
    controller.activate();
    calls[0]!.resolve({
      available: true,
      pullRequests: [pullRequest(7, { mine: true })],
    });
    await flush();

    const checkouts: string[] = [];
    const record = <T>(value: T) =>
      Object.fromEntries(SIDEBAR_SECTIONS.map((s) => [s, value])) as Record<
        SidebarSection,
        T
      >;
    const context: RuntimeSidebarContext = {
      snapshot: snapshot([ref("feature-7", "tip7")]),
      contentHeight: 40,
      sidebarPaneWidth: 30,
      paneTop: 2,
      view: "history",
      leftCollapsed: false,
      branchFilter: "",
      branchFilterActive: false,
      suppressEnterUntil: 0,
      sidebarPreferred: record<number | undefined>(undefined),
      sidebarCollapsed: record(false),
      sidebarStart: record(0),
      sidebarPendingScroll: record(0),
      sidebarScrollTimers: record<ReturnType<typeof setTimeout> | undefined>(
        undefined,
      ),
      branchSelection: { local: 0, remote: 0 },
      doubleClickMs: 400,
      branchFilterInput: { value: "" } as never,
      layout: () => {},
      paint: () => {},
      paintSidebar: () => {},
      paintHints: () => {},
      persistLayoutPreferences: () => {},
      notify: () => {},
      checkoutBranch: async (branch) => {
        checkouts.push(branch.name);
      },
      openSubmodule: async () => {},
      openWorktree: async () => {},
      openGraphMenu: () => {},
      pullRequests: controller,
    };
    const row = layoutSidebarSections(
      context.contentHeight,
      context.sidebarPreferred,
      context.sidebarCollapsed,
      sidebarHiddenSections(controller.panel),
    ).pullRequests.contentTop;

    sidebarClick(context, 3, row, MouseButton.LEFT);
    await flush();
    expect(events.focused).toEqual(["tip7"]);
    expect(events.opened).toEqual([]);

    sidebarClick(context, 3, row, MouseButton.LEFT);
    await flush();
    expect(events.opened).toEqual(["https://github.com/owner/repo/pull/7"]);
    expect(checkouts).toEqual([]);
  });
});
