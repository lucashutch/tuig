import { expect, test } from "bun:test";
import type { StyledText } from "@opentui/core";
import type { Commit, RepositorySnapshot } from "../../src/git/types.js";
import {
  worktreeRows,
  fitColumns,
  formatAge,
  formatHints,
  layoutChangeSections,
  renderHeader,
  sidebarRemoteHeaderRow,
  sidebarScrollStarts,
  renderToolbar,
  sidebarToggleTarget,
  toolbarButtons,
  toolbarHit,
  wrappedLineCount,
  presentCommitMeta,
  presentCommitDetail,
  layoutCommitDetail,
  workingChangesBanner,
  workingChangesBannerLines,
  workingChangesBannerRows,
  COMMIT_COMPOSER_HEIGHT,
  layoutSidebarSections,
  sidebarHeader,
  sidebarRows,
  sidebarScrollbar,
  renderSidebarViewport,
  resizeSidebarBoundary,
  submoduleStatusColor,
} from "../../src/ui/runtime-presentation.js";
import {
  authorAvatar,
  authorInitials,
  filterBranchRefs,
  formatCommitAuthor,
  formatRelativeTime,
} from "../../src/ui/history.js";

test("runtime presentation text helpers fit and wrap text", () => {
  expect(fitColumns("abcdef", 4, true)).toBe("abc…");
  expect(fitColumns("猫", 3)).toBe("猫 ");
  expect(wrappedLineCount("abc\ndefgh", 3)).toBe(3);
});

test("author badges and relative timestamps are deterministic and terminal-safe", () => {
  expect(authorInitials("Ada Lovelace", "ada@example.test")).toBe("AL");
  expect(authorAvatar("Ada Lovelace", "ada@example.test")).toBe("[AL]");
  expect(
    formatRelativeTime(
      "2024-01-01T00:00:00Z",
      Date.parse("2024-01-01T02:00:00Z"),
    ),
  ).toBe("2h ago");
  expect(
    formatCommitAuthor(
      "Ada Lovelace",
      "ada@example.test",
      "2024-01-01T00:00:00Z",
      Date.parse("2024-01-01T02:00:00Z"),
    ),
  ).toBe("[AL] 2h ago");
});

test("branch filters match display and full ref names without mutating refs", () => {
  const refs = [
    { name: "main", fullName: "refs/heads/main", remote: false },
    {
      name: "origin/release",
      fullName: "refs/remotes/origin/release",
      remote: true,
    },
  ] as RepositorySnapshot["branches"];
  expect(filterBranchRefs(refs, "RELEASE").map((ref) => ref.name)).toEqual([
    "origin/release",
  ]);
  expect(filterBranchRefs(refs, "")).toEqual(refs);
  expect(refs).toHaveLength(2);
});

test("runtime presentation identifies sidebar controls and scroll bounds", () => {
  expect(sidebarToggleTarget(3, false, 12)).toBe("local");
  expect(sidebarToggleTarget(15, false, 10)).toBe("remote");
  expect(sidebarToggleTarget(5, true, 10)).toBe("remote");
  expect(sidebarToggleTarget(9, false, 12)).toBeUndefined();
  expect(
    sidebarScrollStarts({
      y: 2,
      delta: -3,
      localBranchCount: 12,
      remoteBranchCount: 4,
      localBranchStart: 2,
      remoteBranchStart: 0,
      localBranchesCollapsed: false,
      remoteBranchesCollapsed: false,
    }),
  ).toEqual({ localBranchStart: 0, remoteBranchStart: 0 });
});

const plain = (styled: StyledText) =>
  styled.chunks.map((chunk) => chunk.text).join("");

test("header reports branch, sync state, and dirty count", () => {
  const snapshot = {
    root: "/tmp/demo",
    branch: "feat/graph",
    upstream: "origin/feat/graph",
    ahead: 2,
    behind: 1,
    files: [{ path: "a.ts", state: "modified", staged: false, unstaged: true }],
    branches: [],
    stashes: [],
    worktrees: [],
    submodules: [],
    commits: [],
  } as unknown as RepositorySnapshot;
  const header = plain(
    renderHeader({
      snapshot,
      repositoryRoot: "/tmp/demo",
      width: 100,
      syncedAt: 0,
      now: 125_000,
    }),
  );
  expect(header).toContain("demo");
  expect(header).toContain("feat/graph");
  expect(header).toContain("↑2");
  expect(header).toContain("↓1");
  expect(header).toContain("1 changed");
  expect(header).toContain("synced 2m ago");
});

test("header falls back before the first snapshot arrives", () => {
  const header = plain(
    renderHeader({ repositoryRoot: "/tmp/demo/", width: 40 }),
  );
  expect(header).toContain("demo");
  expect(header).toContain("not synced");
});

test("hints follow focus and composer state", () => {
  expect(
    formatHints({ focus: "history", view: "history", composing: false }),
  ).toContain("j/k move");
  expect(
    formatHints({ focus: "changes", view: "history", composing: false }),
  ).toContain("t section");
  expect(
    formatHints({ focus: "history", view: "commit", composing: false }),
  ).toContain("esc back to graph");
  expect(
    formatHints({ focus: "history", view: "history", composing: true }),
  ).toBe("COMPOSER  ↵ commit  ⇥ summary/description  esc cancel");
});

test("sync age reads as a relative time", () => {
  expect(formatAge(undefined)).toBe("not synced");
  expect(formatAge(1000, 4000)).toBe("synced just now");
  expect(formatAge(0, 30_000)).toBe("synced 30s ago");
  expect(formatAge(0, 5 * 60_000)).toBe("synced 5m ago");
  expect(formatAge(0, 3 * 3_600_000)).toBe("synced 3h ago");
});

test("remote branch header row tracks the local list", () => {
  expect(sidebarRemoteHeaderRow(3, false)).toBe(7);
  expect(sidebarRemoteHeaderRow(3, true)).toBe(4);
  expect(sidebarRemoteHeaderRow(50, false)).toBe(14);
});

test("change sections default to a midpoint and clamp a dragged divider", () => {
  const layout = layoutChangeSections({
    available: 40,
    unstagedRows: 3,
    stagedRows: 1,
    unstagedCollapsed: false,
    stagedCollapsed: false,
  });
  expect(layout.unstagedTop).toBe(1);
  expect(COMMIT_COMPOSER_HEIGHT).toBeGreaterThan(8);
  expect(layout.composerHeight).toBe(COMMIT_COMPOSER_HEIGHT);
  expect(layout.unstagedHeight + layout.stagedHeight).toBe(
    40 - 5 - COMMIT_COMPOSER_HEIGHT,
  );
  expect(layout.unstagedHeight).toBe(
    Math.floor((40 - 5 - COMMIT_COMPOSER_HEIGHT) / 2),
  );
  expect(layout.unstagedDividerTop).toBe(2 + layout.unstagedHeight);
  expect(layout.stagedTop).toBe(layout.unstagedDividerTop + 1);
  expect(layout.composerDividerTop).toBe(
    layout.stagedTop + 1 + layout.stagedHeight,
  );
  expect(layout.composerTop).toBe(layout.composerDividerTop + 1);
});

test("change section divider preserves a preferred height within usable bounds", () => {
  const layout = layoutChangeSections({
    available: 20,
    unstagedRows: 99,
    stagedRows: 1,
    unstagedCollapsed: false,
    stagedCollapsed: false,
    preferredUnstagedHeight: 99,
  });
  expect(layout.unstagedHeight).toBe(2);
  expect(layout.stagedHeight).toBe(1);
});

test("a collapsed section gives all of its rows to the other list", () => {
  const layout = layoutChangeSections({
    available: 30,
    unstagedRows: 2,
    stagedRows: 2,
    unstagedCollapsed: true,
    stagedCollapsed: false,
  });
  expect(layout.unstagedHeight).toBe(0);
  expect(layout.stagedHeight).toBe(30 - 5 - COMMIT_COMPOSER_HEIGHT);
  expect(layout.stagedTop).toBe(3);
});

test("collapsing both sections leaves only the composer", () => {
  const layout = layoutChangeSections({
    available: 24,
    unstagedRows: 5,
    stagedRows: 5,
    unstagedCollapsed: true,
    stagedCollapsed: true,
  });
  expect(layout.unstagedHeight).toBe(0);
  expect(layout.stagedHeight).toBe(0);
  expect(layout.composerTop).toBe(5);
});

test("the toolbar disables actions the repository cannot take", () => {
  const snapshot = {
    branch: "main",
    upstream: undefined,
    files: [],
    stashes: [],
    branches: [],
    worktrees: [],
    submodules: [],
    commits: [],
  } as unknown as RepositorySnapshot;
  const disabled = Object.fromEntries(
    toolbarButtons(snapshot).map((button) => [button.id, button.enabled]),
  );
  expect(disabled).toMatchObject({
    fetch: true,
    pull: false,
    push: false,
    stash: false,
    pop: false,
  });
  const dirty = Object.fromEntries(
    toolbarButtons({
      ...snapshot,
      upstream: "origin/main",
      files: [{ path: "a.ts" }],
      stashes: [{ ref: "stash@{0}" }],
    } as unknown as RepositorySnapshot).map((button) => [
      button.id,
      button.enabled,
    ]),
  );
  expect(dirty).toMatchObject({
    pull: true,
    push: true,
    stash: true,
    pop: true,
  });
});

test("the toolbar centres its buttons and reports their columns", () => {
  const { content, hits } = renderToolbar(
    [
      { id: "pull", label: "Pull", glyph: "↓", enabled: true },
      { id: "push", label: "Push", glyph: "↑", enabled: false },
    ],
    40,
  );
  const [labels = "", glyphs = ""] = plain(content).split("\n");
  expect(labels).toHaveLength(40);
  expect(glyphs).toHaveLength(40);
  expect(labels.trim()).toBe("Pull    Push");
  // A disabled button is drawn but takes no clicks.
  expect(hits.map((hit) => hit.id)).toEqual(["pull"]);
  expect(toolbarHit(hits, hits[0]!.start)).toBe("pull");
  expect(toolbarHit(hits, hits[0]!.end)).toBeUndefined();
});

test("marks the worktree the session has open", () => {
  const worktrees = [
    { path: "/repos/lib", sha: "a", bare: false, detached: false },
    {
      path: "/tmp/lib-review/",
      sha: "b",
      bare: false,
      detached: true,
      prunable: "gitdir file points to non-existent location",
    },
  ];
  expect(worktreeRows(worktrees, "/repos/lib")).toEqual([
    { label: " ◉ lib", current: true },
    { label: " ⎇ lib-review ⚠", current: false },
  ]);
  // A session opened in a linked worktree marks that one instead.
  expect(worktreeRows(worktrees, "/tmp/lib-review")[1]?.current).toBe(true);
  // Long names are clipped rather than wrapped out of the pane.
  expect(
    worktreeRows(
      [{ ...worktrees[0]!, path: "/repos/a-very-long-worktree" }],
      "",
      16,
    ),
  ).toEqual([{ label: " ⎇ a-very-long…", current: false }]);
  expect(worktreeRows([], "/repos/lib")).toEqual([
    { label: "  (none)", current: false },
  ]);
});

test("commit metadata includes both local author and committer timestamps", () => {
  const text = plain(
    presentCommitMeta({
      sha: "abcdef123",
      parents: [],
      author: "Author",
      authorEmail: "author@test",
      authoredAt: "2024-01-02T03:04:05Z",
      committer: "Committer",
      committerEmail: "commit@test",
      committedAt: "2024-01-03T03:04:05Z",
      subject: "subject",
      body: "body",
      decorations: [],
    }).info,
  );
  expect(text).toContain("Author: Author");
  expect(text).toContain("Email: author@test");
  expect(text).toContain("Authored:");
  expect(text).toContain("Committer: Committer <commit@test>");
  expect(text).toContain("Committed:");
});

test("commit metadata omits a duplicate committer", () => {
  const text = plain(
    presentCommitMeta({
      sha: "abcdef123",
      parents: [],
      author: "Author",
      authorEmail: "author@test",
      authoredAt: "2024-01-02T03:04:05Z",
      committer: "Author",
      committerEmail: "author@test",
      committedAt: "2024-01-03T03:04:05Z",
      subject: "subject",
      body: "body",
      decorations: [],
    }).info,
  );
  expect(text).not.toContain("Committer:");
  expect(text).not.toContain("Committed:");
});

test("commit detail keeps graph, message, files, and diff on one surface", () => {
  const commit: Commit = {
    sha: "abcdef123456",
    parents: ["parent"],
    author: "Author",
    authorEmail: "author@test",
    authoredAt: "2024-01-02T03:04:05Z",
    committer: "Committer",
    committerEmail: "commit@test",
    committedAt: "2024-01-03T03:04:05Z",
    subject: "subject",
    body: "body",
    decorations: [],
  };
  const detail = presentCommitDetail({
    commit,
    changedFiles: [
      { path: "src/a.ts", state: "modified", staged: false, unstaged: false },
      { path: "src/b.ts", state: "added", staged: false, unstaged: false },
    ],
    workingFileCount: 1,
    detailsWidth: 48,
    terminalHeight: 32,
    diffOpen: true,
  });

  expect(detail.surface).toBe("commit-detail");
  expect(detail.history).toEqual({ visible: true, selectedSha: commit.sha });
  expect(detail.metadata).toMatchObject({
    sha: commit.sha,
    shortSha: "abcdef12",
    author: "Author",
    committer: "Committer",
  });
  expect(detail.message).toEqual({ subject: "subject", body: "body" });
  expect(detail.changedFiles.count).toBe(2);
  expect(detail.changedFiles.summary).toBe("2 changed files");
  expect(detail.changedFiles.byState).toMatchObject({ modified: 1, added: 1 });
  expect(detail.layout.bannerRows).toBe(2);
  expect(detail.layout.metadataTop).toBeGreaterThanOrEqual(
    detail.layout.messageTop + detail.layout.messageHeight + 1,
  );
  expect(detail.layout.changedFilesTop).toBeGreaterThanOrEqual(
    detail.layout.metadataTop + detail.layout.metadataHeight + 1,
  );
  expect(detail.layout.diffTop).toBe(2);
  expect(detail.diff).toMatchObject({
    visible: true,
    mode: "open",
    top: detail.layout.diffTop,
    height: detail.layout.diffHeight,
  });
  expect(detail.diff.workingChangesBanner).toMatchObject({
    visible: true,
    fileCount: 1,
    rows: 2,
    text: "1 file change in working directory  ·  View Changes",
  });
});

test("empty commit detail has a stable placeholder and no working banner", () => {
  const commit = {
    sha: "1234567",
    parents: [],
    author: "Author",
    authorEmail: "",
    authoredAt: "2024-01-02T03:04:05Z",
    committer: "Author",
    committerEmail: "",
    committedAt: "2024-01-02T03:04:05Z",
    subject: "empty",
    decorations: [],
  } satisfies Commit;
  const detail = presentCommitDetail({
    commit,
    detailsWidth: 32,
    terminalHeight: 6,
  });

  expect(detail.changedFiles).toMatchObject({
    count: 0,
    summary: "No changed files",
  });
  expect(detail.diff.visible).toBe(false);
  expect(detail.diff.emptyMessage).toBe(
    "This commit has no textual diff to display.",
  );
  expect(detail.diff.workingChangesBanner).toEqual({
    visible: false,
    fileCount: 0,
    rows: 0,
    text: undefined,
    lines: [],
  });
  expect(detail.layout.changedFilesHeight).toBeGreaterThanOrEqual(1);
  expect(detail.layout.changedFilesTop).toBeGreaterThan(
    detail.layout.metadataTop + detail.layout.metadataHeight,
  );
  expect(
    layoutCommitDetail({
      commit,
      detailsWidth: 32,
      terminalHeight: 6,
      workingFileCount: 0,
    }),
  ).toEqual(detail.layout);
});

test("working-change banner only appears when there are files", () => {
  expect(workingChangesBanner(0)).toBeUndefined();
  expect(workingChangesBanner(1)).toBe(
    "1 file change in working directory  ·  View Changes",
  );
  expect(workingChangesBanner(2)).toContain("2 file changes");
  expect(workingChangesBannerLines(12, 12)).toEqual([
    "12 file cha…",
    "View Changes",
  ]);
  expect(workingChangesBannerRows(2)).toBe(2);
  expect(workingChangesBannerRows(0)).toBe(0);
});

test("composer and both split preferences clamp without hiding open lists", () => {
  const layout = layoutChangeSections({
    available: 24,
    unstagedRows: 20,
    stagedRows: 20,
    unstagedCollapsed: false,
    stagedCollapsed: false,
    preferredUnstagedHeight: 99,
    preferredComposerHeight: 99,
  });
  expect(layout.composerHeight).toBe(17);
  expect(layout.unstagedHeight).toBe(1);
  expect(layout.stagedHeight).toBe(1);
});

test("change sections reserve divider rows and collapse safely in tiny panes", () => {
  const oneRow = layoutChangeSections({
    available: 19,
    unstagedRows: 1,
    stagedRows: 1,
    unstagedCollapsed: false,
    stagedCollapsed: false,
  });
  expect(oneRow.unstagedHeight).toBe(1);
  expect(oneRow.stagedHeight).toBe(1);
  expect(oneRow.unstagedDividerTop).toBeGreaterThan(oneRow.unstagedTop);
  expect(oneRow.composerDividerTop).toBeGreaterThan(oneRow.stagedTop);
  const tiny = layoutChangeSections({
    available: 3,
    unstagedRows: 1,
    stagedRows: 1,
    unstagedCollapsed: false,
    stagedCollapsed: false,
  });
  expect(tiny.composerHeight).toBe(0);
  expect(tiny.composerTop).toBeGreaterThanOrEqual(3);
});

test("sidebar viewports hide unnecessary scrollbars and paint needed ones", () => {
  expect(renderSidebarViewport(["one"], 6, 0, 3)).toEqual([
    "one   ",
    "      ",
    "      ",
  ]);
  expect(renderSidebarViewport(["a", "b", "c", "d"], 4, 1, 2)).toEqual([
    "b  █",
    "c  │",
  ]);
});

test("sidebar sections allocate all rows, retain headers, and expose count-only labels", () => {
  const collapsed = {
    local: false,
    remote: false,
    submodules: true,
    stashes: false,
    worktrees: false,
  };
  const layout = layoutSidebarSections(
    20,
    { local: 10, remote: 1, submodules: 9, stashes: 1, worktrees: 1 },
    collapsed,
  );
  expect(layout.local.headerTop).toBe(0);
  expect(layout.worktrees.headerTop).toBeLessThan(20);
  expect(
    layout.local.contentHeight +
      layout.remote.contentHeight +
      layout.stashes.contentHeight +
      layout.worktrees.contentHeight,
  ).toBe(11);
  expect(sidebarHeader("remote", 136, false)).toBe("▼ REMOTES 136");
  expect(sidebarScrollbar(100, 50, 10)).toEqual({ thumbSize: 1, thumbTop: 5 });
  const tiny = layoutSidebarSections(
    3,
    { local: 1, remote: 1, submodules: 1, stashes: 1, worktrees: 1 },
    collapsed,
  );
  expect(tiny.submodules.headerTop).toBe(2);
  const roomy = layoutSidebarSections(
    30,
    { local: 1, remote: 1, submodules: 1, stashes: 1, worktrees: 1 },
    {
      local: false,
      remote: false,
      submodules: false,
      stashes: false,
      worktrees: false,
    },
  );
  expect(
    Object.values(roomy).every(({ contentHeight }) => contentHeight >= 3),
  ).toBe(true);
});

test("sidebar divider resizes only its adjacent expanded sections", () => {
  const collapsed = {
    local: false,
    remote: false,
    submodules: false,
    stashes: false,
    worktrees: false,
  };
  const layout = layoutSidebarSections(
    30,
    {
      local: undefined,
      remote: undefined,
      submodules: undefined,
      stashes: undefined,
      worktrees: undefined,
    },
    collapsed,
  );
  const resized = resizeSidebarBoundary(
    layout,
    {
      local: undefined,
      remote: undefined,
      submodules: undefined,
      stashes: undefined,
      worktrees: undefined,
    },
    collapsed,
    "remote",
    layout.remote.contentTop + 1,
  );
  expect(resized.remote).toBe(3);
  expect(resized.submodules).toBe(
    layout.remote.contentHeight + layout.submodules.contentHeight - 3,
  );
});

test("submodule sidebar rows use path names and status colours", () => {
  const snapshot = {
    root: "/repo",
    branches: [],
    files: [],
    stashes: [],
    worktrees: [],
    commits: [],
    submodules: [
      { name: "vendor-lib", path: "vendor/lib", state: "clean" },
      { path: "third_party/tool", state: "different" },
    ],
  } as unknown as RepositorySnapshot;
  expect(sidebarRows(snapshot, "submodules", 40)).toEqual([
    " ✓ lib",
    "   vendor/lib",
    " ! tool",
    "   third_party/tool",
  ]);
  const clean = snapshot.submodules[0]!;
  const different = snapshot.submodules[1]!;
  const missing = { ...different, state: "uninitialized" as const };
  expect(submoduleStatusColor(clean)).not.toBe(submoduleStatusColor(different));
  expect(submoduleStatusColor(different)).not.toBe(
    submoduleStatusColor(missing),
  );
});
