import { InputRenderable, MouseButton } from "@opentui/core";
import type { BranchRef, RepositorySnapshot } from "../git/types.js";
import {
  branchRefsForSection,
  clampBranchSelection,
  filterBranchRefs,
} from "./history.js";
import type { GraphMenuTarget } from "./graph-menu.js";
import {
  layoutSidebarSections,
  resizeSidebarBoundary,
  sidebarRows,
  SIDEBAR_SECTIONS,
  type SidebarSection,
} from "./runtime-presentation.js";

/** One frame at 60fps: long enough to batch a wheel burst, short enough to feel instant. */
export const SIDEBAR_SCROLL_INTERVAL_MS = 16;

export interface RuntimeSidebarContext {
  snapshot?: RepositorySnapshot;
  contentHeight: number;
  sidebarPaneWidth: number;
  paneTop: number;
  view: string;
  leftCollapsed: boolean;
  branchFilter: string;
  branchFilterActive: boolean;
  suppressEnterUntil: number;
  sidebarPreferred: Record<SidebarSection, number | undefined>;
  sidebarCollapsed: Record<SidebarSection, boolean>;
  sidebarStart: Record<SidebarSection, number>;
  /** Wheel rows waiting to be applied, one entry per section. */
  sidebarPendingScroll: Record<SidebarSection, number>;
  sidebarScrollTimers: Record<
    SidebarSection,
    ReturnType<typeof setTimeout> | undefined
  >;
  branchSelection: Record<"local" | "remote", number>;
  branchFilterInput: InputRenderable;
  layout(): void;
  paint(): void;
  paintSidebar(): void;
  paintHints(): void;
  persistLayoutPreferences(): void;
  notify(text: string): void;
  checkoutBranch(branch: BranchRef): Promise<void>;
  openGraphMenu(x: number, y: number, target: GraphMenuTarget): void;
}

export function sidebarClick(
  context: RuntimeSidebarContext,
  x: number,
  y: number,
  button: number,
) {
  if (button !== MouseButton.RIGHT && button !== MouseButton.LEFT) return;
  const snapshot = context.snapshot;
  if (!snapshot) return;
  const rects = layoutSidebarSections(
    context.contentHeight,
    context.sidebarPreferred,
    context.sidebarCollapsed,
  );
  const section = (SIDEBAR_SECTIONS as readonly SidebarSection[]).find(
    (candidate) => {
      const rect = rects[candidate];
      return (
        (candidate === "local" ||
          candidate === "remote" ||
          candidate === "stashes" ||
          candidate === "worktrees") &&
        !context.sidebarCollapsed[candidate] &&
        y >= rect.contentTop &&
        y < rect.contentTop + rect.contentHeight
      );
    },
  );
  if (!section) return;
  const row = context.sidebarStart[section] + y - rects[section].contentTop;
  if (section === "stashes") {
    // Stashes render as two rows (subject, then muted branch and age).
    const stash = snapshot.stashes[Math.floor(row / 2)];
    if (stash)
      context.openGraphMenu(x, y + context.paneTop, { sha: stash.sha, stash });
    return;
  }
  if (section === "worktrees") {
    const worktree = snapshot.worktrees[row];
    if (worktree)
      context.openGraphMenu(x, y + context.paneTop, {
        sha: worktree.sha,
        worktree,
      });
    return;
  }
  const branches = filterBranchRefs(
    snapshot.branches.filter((branch) =>
      section === "local" ? !branch.remote : branch.remote,
    ),
    context.branchFilter,
  );
  const branch = branches[row];
  if (!branch) return;
  if (button === MouseButton.LEFT) void context.checkoutBranch(branch);
  else
    context.openGraphMenu(x, y + context.paneTop, { sha: branch.sha, branch });
}

export function startBranchFilter(context: RuntimeSidebarContext) {
  if (context.view !== "history")
    return context.notify("Branch filter is available from the graph");
  if (context.leftCollapsed) context.leftCollapsed = false;
  context.branchFilterActive = true;
  context.branchFilterInput.value = context.branchFilter;
  context.branchFilterInput.visible = !context.leftCollapsed;
  context.layout();
  context.paintHints();
  context.paint();
  setTimeout(() => context.branchFilterInput.focus(), 0);
}

export function finishBranchFilter(context: RuntimeSidebarContext) {
  if (!context.branchFilterActive) return;
  context.branchFilterActive = false;
  context.branchFilterInput.blur();
  context.branchFilterInput.visible = false;
  context.layout();
  context.paintHints();
  context.paint();
}

export function acceptBranchFilter(context: RuntimeSidebarContext) {
  finishBranchFilter(context);
  context.suppressEnterUntil = Date.now() + 100;
  setTimeout(() => {
    if (Date.now() >= context.suppressEnterUntil)
      context.suppressEnterUntil = 0;
  }, 100);
}

export function activateFilteredBranch(context: RuntimeSidebarContext) {
  const snapshot = context.snapshot;
  if (!snapshot) return acceptBranchFilter(context);
  const filtered = branchRefsForSection(
    snapshot.branches,
    "local",
    context.branchFilter,
  );
  const index = clampBranchSelection(
    context.branchSelection.local,
    filtered.length,
  );
  const branch = index >= 0 ? filtered[index] : undefined;
  finishBranchFilter(context);
  if (branch) void context.checkoutBranch(branch);
}

export function cancelBranchFilter(context: RuntimeSidebarContext) {
  cancelSidebarScroll(context);
  context.branchFilter = "";
  context.branchFilterInput.value = "";
  context.sidebarStart.local = 0;
  context.sidebarStart.remote = 0;
  finishBranchFilter(context);
}

export function toggleSidebarSection(
  context: RuntimeSidebarContext,
  section: SidebarSection,
) {
  context.sidebarCollapsed[section] = !context.sidebarCollapsed[section];
  context.persistLayoutPreferences();
  context.paintSidebar();
}

/** Rows a section can scroll past before its last row reaches the top. */
function sidebarScrollLimit(
  context: RuntimeSidebarContext,
  section: SidebarSection,
  contentHeight: number,
): number {
  const snapshot = context.snapshot;
  if (!snapshot) return 0;
  const rows = sidebarRows(
    snapshot,
    section,
    context.sidebarPaneWidth,
    context.branchFilter,
  );
  return Math.max(0, rows.length - contentHeight);
}

/**
 * Batch wheel events per section before repainting.
 *
 * Terminals deliver a flick as a burst of separate scroll events, and each one
 * used to force a full-screen repaint. Accumulating them over one frame turns
 * the burst into a single sidebar repaint.
 */
export function sidebarScroll(
  context: RuntimeSidebarContext,
  y: number,
  delta: number,
) {
  if (!context.snapshot) return;
  const rects = layoutSidebarSections(
    context.contentHeight,
    context.sidebarPreferred,
    context.sidebarCollapsed,
  );
  const section = SIDEBAR_SECTIONS.find(
    (candidate) =>
      y >= rects[candidate].contentTop &&
      y < rects[candidate].contentTop + rects[candidate].contentHeight,
  );
  if (!section || context.sidebarCollapsed[section]) return;
  context.sidebarPendingScroll[section] += delta;
  if (context.sidebarScrollTimers[section]) return;
  context.sidebarScrollTimers[section] = setTimeout(() => {
    const movement = context.sidebarPendingScroll[section];
    context.sidebarPendingScroll[section] = 0;
    context.sidebarScrollTimers[section] = undefined;
    applySidebarScroll(context, section, movement);
  }, SIDEBAR_SCROLL_INTERVAL_MS);
}

/** Move one section's viewport, clamped to its row count. */
export function applySidebarScroll(
  context: RuntimeSidebarContext,
  section: SidebarSection,
  delta: number,
) {
  if (!context.snapshot || delta === 0) return;
  // Sizes can change while the batch waits, so measure at apply time.
  const contentHeight = layoutSidebarSections(
    context.contentHeight,
    context.sidebarPreferred,
    context.sidebarCollapsed,
  )[section].contentHeight;
  context.sidebarStart[section] = Math.max(
    0,
    Math.min(
      sidebarScrollLimit(context, section, contentHeight),
      context.sidebarStart[section] + delta,
    ),
  );
  context.paintSidebar();
}

/** Drop queued wheel rows, for use when the sidebar contents change. */
export function cancelSidebarScroll(context: RuntimeSidebarContext) {
  for (const section of SIDEBAR_SECTIONS) {
    const timer = context.sidebarScrollTimers[section];
    if (timer) clearTimeout(timer);
    context.sidebarScrollTimers[section] = undefined;
    context.sidebarPendingScroll[section] = 0;
  }
}

export function resizeSidebar(
  context: RuntimeSidebarContext,
  section: SidebarSection,
  y: number,
) {
  const layout = layoutSidebarSections(
    context.contentHeight,
    context.sidebarPreferred,
    context.sidebarCollapsed,
  );
  context.sidebarPreferred = resizeSidebarBoundary(
    layout,
    context.sidebarPreferred,
    context.sidebarCollapsed,
    section,
    y,
  );
  context.persistLayoutPreferences();
  context.paintSidebar();
}
