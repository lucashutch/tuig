import {
  SIDEBAR_BRANCH_LIMIT,
  SIDEBAR_LOCAL_HEADER_ROW,
  sidebarRemoteHeaderRow,
} from "./runtime-presentation-sidebar.js";

/** Rows the commit composer block occupies at the foot of the changes pane. */
/** A useful editor, rather than the former three-line description field. */
export const COMMIT_COMPOSER_HEIGHT = 12;
export const MIN_COMMIT_COMPOSER_HEIGHT = 6;

export type ChangeSectionLayoutInput = {
  /** Rows the pane can use, excluding the bottom hints row. */
  available: number;
  unstagedRows: number;
  stagedRows: number;
  unstagedCollapsed: boolean;
  stagedCollapsed: boolean;
  /** Persisted height selected by dragging the staged-section divider. */
  preferredUnstagedHeight?: number;
  /** Persisted height selected by dragging the composer divider. */
  preferredComposerHeight?: number;
};

export type ChangeSectionLayout = {
  unstagedTop: number;
  unstagedHeight: number;
  stagedTop: number;
  stagedHeight: number;
  composerTop: number;
  composerHeight: number;
  /** Dedicated rows between the two lists and above the composer. */
  unstagedDividerTop: number;
  composerDividerTop: number;
};

/**
 * Split the changes pane between the unstaged list, the staged list, and the
 * commit composer. By default the divider sits in the middle; a dragged
 * preferred height survives subsequent paints and terminal resizes.
 */
export function layoutChangeSections({
  available,
  unstagedCollapsed,
  stagedCollapsed,
  preferredUnstagedHeight,
  preferredComposerHeight,
}: ChangeSectionLayoutInput): ChangeSectionLayout {
  // Row 0 holds actions.  Both headings and both divider rows are structural:
  // do not let a drag handle sit on the last row of a one-line list.
  const open = Number(!unstagedCollapsed) + Number(!stagedCollapsed);
  const fixedRows = 5; // actions, two headings, two dividers
  const composerMaximum = Math.max(0, available - fixedRows - open);
  const composerHeight = Math.min(
    composerMaximum,
    Math.max(0, preferredComposerHeight ?? COMMIT_COMPOSER_HEIGHT),
  );
  const room = Math.max(0, available - fixedRows - composerHeight);
  let unstagedHeight = 0;
  let stagedHeight = 0;
  if (open === 1) {
    if (unstagedCollapsed) stagedHeight = room;
    else unstagedHeight = room;
  } else if (open === 2) {
    if (room < 2) {
      unstagedHeight = room;
    } else {
      const preferred = preferredUnstagedHeight ?? Math.floor(room / 2);
      unstagedHeight = Math.max(1, Math.min(room - 1, preferred));
    }
    stagedHeight = room - unstagedHeight;
  }
  const unstagedTop = 1;
  const unstagedDividerTop = unstagedTop + 1 + unstagedHeight;
  const stagedTop = unstagedDividerTop + 1;
  const composerDividerTop = stagedTop + 1 + stagedHeight;
  return {
    unstagedTop,
    unstagedHeight,
    stagedTop,
    stagedHeight,
    composerTop: composerDividerTop + 1,
    composerHeight,
    unstagedDividerTop,
    composerDividerTop,
  };
}

export function sidebarToggleTarget(
  y: number,
  localBranchesCollapsed: boolean,
  localBranchCount: number,
): "local" | "remote" | undefined {
  // The text is inset one row inside the pane, so a rendered row N is at y N+1.
  const localHeaderY = SIDEBAR_LOCAL_HEADER_ROW + 1;
  if (y === localHeaderY) return "local";
  const remoteHeaderY =
    sidebarRemoteHeaderRow(localBranchCount, localBranchesCollapsed) + 1;
  return y === remoteHeaderY ? "remote" : undefined;
}

export function sidebarScrollStarts({
  y,
  delta,
  localBranchCount,
  remoteBranchCount,
  localBranchStart,
  remoteBranchStart,
  localBranchesCollapsed,
  remoteBranchesCollapsed,
}: {
  y: number;
  delta: number;
  localBranchCount: number;
  remoteBranchCount: number;
  localBranchStart: number;
  remoteBranchStart: number;
  localBranchesCollapsed: boolean;
  remoteBranchesCollapsed: boolean;
}): { localBranchStart: number; remoteBranchStart: number } {
  const remoteHeaderY =
    sidebarRemoteHeaderRow(localBranchCount, localBranchesCollapsed) + 1;
  if (y < remoteHeaderY && !localBranchesCollapsed)
    return {
      localBranchStart: Math.max(
        0,
        Math.min(
          localBranchCount - SIDEBAR_BRANCH_LIMIT,
          localBranchStart + delta,
        ),
      ),
      remoteBranchStart,
    };
  if (!remoteBranchesCollapsed)
    return {
      localBranchStart,
      remoteBranchStart: Math.max(
        0,
        Math.min(
          remoteBranchCount - SIDEBAR_BRANCH_LIMIT,
          remoteBranchStart + delta,
        ),
      ),
    };
  return { localBranchStart, remoteBranchStart };
}
