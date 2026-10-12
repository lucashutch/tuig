import { describe, expect, test } from "bun:test";
import type { CheckRollup } from "../../src/git/pull-request-types.js";
import type { BranchRef } from "../../src/git/types.js";
import {
  PULL_REQUEST_DRAFT_ICON,
  PULL_REQUEST_OPEN_ICON,
  mixColor,
  pullRequestBranch,
  pullRequestCommitIndex,
  pullRequestHistoryCell,
  pullRequestIcons,
  pullRequestPanel,
  sidebarPullRequests,
} from "../../src/ui/pull-requests.js";
import {
  layoutSidebarSections,
  sidebarHiddenSections,
  SIDEBAR_SECTIONS,
  type SidebarSection,
} from "../../src/ui/runtime-presentation.js";
import {
  PR_COLUMN_WIDTH,
  historyColumnLayout,
  visibleHistoryColumns,
} from "../../src/ui/history-columns.js";
import { oneDarkTheme } from "../../src/ui/theme.js";
import { pullRequest } from "./pull-request-fixtures.js";

const ref = (name: string, sha: string, remote = false): BranchRef => ({
  name,
  fullName: remote ? `refs/remotes/${name}` : `refs/heads/${name}`,
  sha,
  current: false,
  remote,
});

describe("pull request icons", () => {
  const theme = oneDarkTheme;
  const cases: Array<[CheckRollup, string, string]> = [
    ["failed", "✗", theme.deleted],
    ["running", "⠙", theme.warning],
    ["passed", "✓", theme.added],
    ["pending", "…", theme.muted],
    ["none", "·", theme.muted],
  ];
  for (const [checks, glyph, color] of cases)
    test(`${checks} checks`, () => {
      expect(
        pullRequestIcons({ state: "open", checks }, theme, "⠙").checks,
      ).toEqual({ glyph, color });
    });

  test("tentative checks look like a dimmer pass", () => {
    const tentative = pullRequestIcons(
      { state: "open", checks: "tentative" },
      theme,
    ).checks;
    const passed = pullRequestIcons(
      { state: "open", checks: "passed" },
      theme,
    ).checks;
    expect(tentative.glyph).toBe(passed.glyph);
    expect(tentative.color).not.toBe(passed.color);
    expect(tentative.color).toBe(mixColor(theme.added, theme.bg, 0.5));
  });

  test("open and draft states", () => {
    expect(
      pullRequestIcons({ state: "open", checks: "none" }, theme).state,
    ).toEqual({ glyph: PULL_REQUEST_OPEN_ICON, color: theme.added });
    expect(
      pullRequestIcons({ state: "draft", checks: "none" }, theme).state,
    ).toEqual({ glyph: PULL_REQUEST_DRAFT_ICON, color: theme.muted });
  });

  test("every glyph takes one cell, so rows stay aligned", () => {
    for (const checks of [
      "failed",
      "running",
      "tentative",
      "passed",
      "pending",
      "none",
    ] as const)
      for (const state of ["open", "draft"] as const) {
        const icons = pullRequestIcons({ state, checks }, theme);
        expect(Bun.stringWidth(icons.state.glyph)).toBe(1);
        expect(Bun.stringWidth(icons.checks.glyph)).toBe(1);
      }
  });

  test("colors that are not hex are left alone when mixing", () => {
    expect(mixColor("red", "#000000", 0.5)).toBe("red");
    expect(mixColor("#FFFFFF", "#000000", 0.5)).toBe("#808080");
  });
});

describe("sidebar pull requests", () => {
  test("lists yours, then review requests, each newest first, once each", () => {
    const listed = sidebarPullRequests([
      pullRequest(1, { mine: true }),
      pullRequest(9, { reviewRequested: true }),
      pullRequest(5, { mine: true, reviewRequested: true }),
      pullRequest(7, {}),
      pullRequest(3, { reviewRequested: true }),
    ]);
    expect(listed.map((pr) => pr.number)).toEqual([5, 1, 9, 3]);
  });

  test("hides for missing gh, sign-in, or non-GitHub remotes", () => {
    for (const reason of [
      "gh-missing",
      "not-authenticated",
      "not-github",
    ] as const)
      expect(pullRequestPanel(true, { available: false, reason })).toEqual({
        kind: "hidden",
      });
    expect(
      pullRequestPanel(false, { available: true, pullRequests: [] }).kind,
    ).toBe("hidden");
  });

  test("shows loading, errors, and the list", () => {
    expect(pullRequestPanel(true, undefined)).toEqual({ kind: "loading" });
    expect(
      pullRequestPanel(true, {
        available: false,
        reason: "error",
        message: "API rate limit exceeded",
      }),
    ).toEqual({ kind: "message", text: "API rate limit exceeded" });
    const panel = pullRequestPanel(true, {
      available: true,
      pullRequests: [pullRequest(2, { mine: true }), pullRequest(3)],
    });
    expect(panel.kind === "list" && panel.pullRequests.length).toBe(1);
  });

  test("a hidden section gives its rows to the other sections", () => {
    const record = <T>(value: T) =>
      Object.fromEntries(SIDEBAR_SECTIONS.map((s) => [s, value])) as Record<
        SidebarSection,
        T
      >;
    const hidden = layoutSidebarSections(
      40,
      record(undefined),
      record(false),
      sidebarHiddenSections({ kind: "hidden" }),
    );
    const shown = layoutSidebarSections(
      40,
      record(undefined),
      record(false),
      sidebarHiddenSections({ kind: "loading" }),
    );
    expect(hidden.pullRequests.hidden).toBe(true);
    expect(hidden.remote.headerTop).toBe(hidden.local.dividerTop! + 1);
    expect(shown.pullRequests.contentHeight).toBeGreaterThan(0);
    expect(shown.remote.headerTop).toBe(shown.pullRequests.dividerTop! + 1);
    const used = (layout: typeof hidden) =>
      SIDEBAR_SECTIONS.reduce(
        (sum, s) =>
          sum +
          (layout[s].hidden ? 0 : 1) +
          layout[s].contentHeight +
          (layout[s].dividerTop === undefined ? 0 : 1),
        0,
      );
    expect(used(hidden)).toBe(40);
    expect(used(shown)).toBe(40);
  });
});

describe("pull request branch matching", () => {
  const branches = [
    ref("main", "m1"),
    ref("feature-1", "local1"),
    ref("origin/feature-1", "remote1", true),
    ref("upstream/feature-2", "remote2", true),
    ref("origin/feature-3", "remote3", true),
  ];

  test("prefers a local branch, then origin, then another remote", () => {
    expect(pullRequestBranch(pullRequest(1), branches)?.sha).toBe("local1");
    expect(pullRequestBranch(pullRequest(2), branches)?.sha).toBe("remote2");
    expect(pullRequestBranch(pullRequest(3), branches)?.sha).toBe("remote3");
    expect(pullRequestBranch(pullRequest(4), branches)).toBeUndefined();
  });

  test("a fork's branch never matches by name", () => {
    expect(
      pullRequestBranch(pullRequest(1, { fromFork: true }), branches),
    ).toBeUndefined();
  });

  test("history rows match by local or remote label, or head commit", () => {
    const index = pullRequestCommitIndex(
      [
        pullRequest(1),
        pullRequest(2),
        pullRequest(5, { headBranch: "main", fromFork: true, headSha: "fork" }),
      ],
      branches,
    );
    const numbers = (sha: string, decorations: string[]) =>
      index.forCommit({ sha, decorations }).map((pr) => pr.number);
    expect(numbers("local1", ["HEAD -> feature-1"])).toEqual([1]);
    expect(numbers("remote2", ["upstream/feature-2"])).toEqual([2]);
    // The fork's head branch shares a name with main but lives elsewhere.
    expect(numbers("m1", ["main", "tag: v1"])).toEqual([]);
    expect(numbers("fork", [])).toEqual([5]);
  });

  test("several matches list the newest first", () => {
    const index = pullRequestCommitIndex(
      [
        pullRequest(4, { headBranch: "feature-1" }),
        pullRequest(8, { headBranch: "feature-1" }),
        pullRequest(6, { headSha: "local1", headBranch: "other" }),
      ],
      branches,
    );
    const matches = index.forCommit({
      sha: "local1",
      decorations: ["feature-1", "origin/feature-1"],
    });
    expect(matches.map((pr) => pr.number)).toEqual([8, 6, 4]);
    const cell = pullRequestHistoryCell(matches, PR_COLUMN_WIDTH, oneDarkTheme);
    expect(cell.map((segment) => segment.text).join("")).toBe("#8 ✓ +2  ");
    expect(cell[0]!.color).toBe(oneDarkTheme.added);
  });
});

describe("history PR column", () => {
  test("is drawn only when there is pull request data", () => {
    const columns = { showCommitter: true, showSha: true };
    const without = historyColumnLayout(
      120,
      3,
      visibleHistoryColumns(columns, false),
    );
    const withData = historyColumnLayout(
      120,
      3,
      visibleHistoryColumns(columns, true),
    );
    expect(without.prWidth).toBe(0);
    expect(withData.prWidth).toBe(PR_COLUMN_WIDTH);
    expect(withData.messageWidth).toBe(
      without.messageWidth - PR_COLUMN_WIDTH - 3,
    );
    expect(
      historyColumnLayout(
        120,
        3,
        visibleHistoryColumns({ ...columns, showPr: false }, true),
      ).prWidth,
    ).toBe(0);
  });
});
