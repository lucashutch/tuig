import { describe, expect, test } from "bun:test";
import type { BranchRef, RepositorySnapshot } from "../../src/git/types.js";
import {
  cancelSidebarScroll,
  sidebarScroll,
  toggleSidebarSection,
  SIDEBAR_SCROLL_INTERVAL_MS,
  type RuntimeSidebarContext,
} from "../../src/ui/runtime-sidebar.js";
import {
  layoutSidebarSections,
  SIDEBAR_SECTIONS,
  type SidebarSection,
} from "../../src/ui/runtime-presentation.js";

const branch = (index: number, remote: boolean): BranchRef => ({
  name: remote ? `origin/b${index}` : `b${index}`,
  fullName: remote ? `refs/remotes/origin/b${index}` : `refs/heads/b${index}`,
  sha: `sha${index}`,
  current: false,
  remote,
});

function snapshotWith(count: number): RepositorySnapshot {
  return {
    root: "/repo",
    head: { branch: "main", sha: "sha0", detached: false },
    branches: [
      ...Array.from({ length: count }, (_, i) => branch(i, false)),
      ...Array.from({ length: count }, (_, i) => branch(i, true)),
    ],
    commits: [],
    commitsComplete: true,
    files: [],
    stashes: [],
    submodules: [],
    worktrees: [],
    remotes: [],
    tags: [],
  } as unknown as RepositorySnapshot;
}

const zeroed = <T>(value: T) =>
  Object.fromEntries(SIDEBAR_SECTIONS.map((s) => [s, value])) as Record<
    SidebarSection,
    T
  >;

function makeContext(branchCount = 40) {
  const counts = { paint: 0, paintSidebar: 0 };
  const context = {
    snapshot: snapshotWith(branchCount),
    contentHeight: 40,
    sidebarPaneWidth: 30,
    paneTop: 2,
    view: "history",
    leftCollapsed: false,
    branchFilter: "",
    branchFilterActive: false,
    suppressEnterUntil: 0,
    sidebarPreferred: zeroed<number | undefined>(undefined),
    sidebarCollapsed: zeroed(false),
    sidebarStart: zeroed(0),
    sidebarPendingScroll: zeroed(0),
    sidebarScrollTimers: zeroed<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    ),
    branchSelection: { local: 0, remote: 0 },
    branchFilterInput: { value: "" } as never,
    layout: () => {},
    paint: () => {
      counts.paint++;
    },
    paintSidebar: () => {
      counts.paintSidebar++;
    },
    paintHints: () => {},
    persistLayoutPreferences: () => {},
    notify: () => {},
    checkoutBranch: async () => {},
    openGraphMenu: () => {},
  } satisfies RuntimeSidebarContext;
  return { context, counts };
}

/** Row inside a section's viewport, in sidebar-local coordinates. */
function rowIn(context: RuntimeSidebarContext, section: SidebarSection) {
  const rects = layoutSidebarSections(
    context.contentHeight,
    context.sidebarPreferred,
    context.sidebarCollapsed,
  );
  return rects[section].contentTop;
}

const settle = () =>
  new Promise((resolve) => setTimeout(resolve, SIDEBAR_SCROLL_INTERVAL_MS * 3));

describe("sidebar scrolling", () => {
  test("batches a wheel burst into one sidebar repaint", async () => {
    const { context, counts } = makeContext();
    const y = rowIn(context, "local");
    for (let i = 0; i < 10; i++) sidebarScroll(context, y, 3);
    // Nothing is drawn until the batch drains.
    expect(counts.paintSidebar).toBe(0);
    expect(context.sidebarStart.local).toBe(0);
    await settle();
    expect(counts.paintSidebar).toBe(1);
    expect(counts.paint).toBe(0);
    expect(context.sidebarStart.local).toBe(30);
  });

  test("keeps a section's last row on screen", async () => {
    const { context } = makeContext();
    const y = rowIn(context, "local");
    sidebarScroll(context, y, 5000);
    await settle();
    const rects = layoutSidebarSections(
      context.contentHeight,
      context.sidebarPreferred,
      context.sidebarCollapsed,
    );
    expect(context.sidebarStart.local).toBe(40 - rects.local.contentHeight);
  });

  test("never scrolls past the top", async () => {
    const { context } = makeContext();
    const y = rowIn(context, "local");
    sidebarScroll(context, y, -9);
    await settle();
    expect(context.sidebarStart.local).toBe(0);
  });

  test("scrolls each section independently", async () => {
    const { context } = makeContext();
    sidebarScroll(context, rowIn(context, "local"), 3);
    sidebarScroll(context, rowIn(context, "remote"), 6);
    await settle();
    expect(context.sidebarStart.local).toBe(3);
    expect(context.sidebarStart.remote).toBe(6);
    expect(context.sidebarStart.stashes).toBe(0);
  });

  test("ignores wheel events over a collapsed section", async () => {
    const { context, counts } = makeContext();
    const y = rowIn(context, "local");
    context.sidebarCollapsed.local = true;
    sidebarScroll(context, y, 3);
    await settle();
    expect(context.sidebarStart.local).toBe(0);
    expect(counts.paintSidebar).toBe(0);
  });

  test("drops queued rows when the branch filter changes", async () => {
    const { context, counts } = makeContext();
    sidebarScroll(context, rowIn(context, "local"), 9);
    cancelSidebarScroll(context);
    await settle();
    expect(context.sidebarStart.local).toBe(0);
    expect(counts.paintSidebar).toBe(0);
  });

  test("collapsing a section repaints only the sidebar", () => {
    const { context, counts } = makeContext();
    toggleSidebarSection(context, "stashes");
    expect(context.sidebarCollapsed.stashes).toBe(true);
    expect(counts.paintSidebar).toBe(1);
    expect(counts.paint).toBe(0);
  });
});
