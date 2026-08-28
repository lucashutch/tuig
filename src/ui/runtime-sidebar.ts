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
  branchSelection: Record<"local" | "remote", number>;
  branchFilterInput: InputRenderable;
  layout(): void;
  paint(): void;
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
    const stash = snapshot.stashes[row];
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
  context.paint();
}

export function sidebarScroll(
  context: RuntimeSidebarContext,
  y: number,
  delta: number,
) {
  const snapshot = context.snapshot;
  if (!snapshot) return;
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
  const rows = sidebarRows(
    snapshot,
    section,
    context.sidebarPaneWidth,
    context.branchFilter,
  );
  context.sidebarStart[section] = Math.max(
    0,
    Math.min(
      Math.max(0, rows.length - rects[section].contentHeight),
      context.sidebarStart[section] + delta,
    ),
  );
  context.paint();
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
  context.paint();
}
