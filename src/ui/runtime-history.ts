import { MouseButton, type CliRenderer } from "@opentui/core";
import type { BranchRef, RepositorySnapshot, Stash } from "../git/types.js";
import { primaryDecorationTag, shortSha } from "./history.js";
import {
  scrollbarDrag,
  scrollbarGrab,
  type ScrollbarGrab,
} from "./scrollbar.js";

export interface RuntimeHistoryContext {
  snapshot?: RepositorySnapshot;
  graphRowCount: number;
  commitIndex: number;
  historySelection: "working" | "commit";
  historyStart: number;
  historyViewportDetached: boolean;
  historyContentLeft: number;
  historyContentWidth: number;
  /** Thumb row the pointer holds while the history scrollbar is dragged. */
  historyScrollbarGrab?: ScrollbarGrab;
  contentHeight: number;
  pendingScroll: number;
  scrollTimer?: ReturnType<typeof setTimeout>;
  scrollSettleTimer?: ReturnType<typeof setTimeout>;
  historyScrolling: boolean;
  lastGraphClick?: { row: number; at: number; label: boolean };
  historyShaHits: Map<number, { start: number; end: number }>;
  historyLabelHits: Map<
    number,
    { start: number; end: number; ref?: BranchRef }
  >;
  renderer: CliRenderer;
  paneTop: number;
  doubleClickMs: number;
  commitDiffVisible: boolean;
  diffOrigin?: "working" | "commit";
  mode: "unstaged" | "staged";
  paint: () => void;
  paintHistory: () => void;
  openCommit: () => unknown;
  openGraphMenu: (
    x: number,
    y: number,
    target: { sha: string; branch?: BranchRef; stash?: Stash; tag?: string },
  ) => void;
  closeDiff: () => void;
  checkoutBranch: (branch: BranchRef) => unknown;
  setFocus: (focus: "history" | "changes") => void;
  notify: (text: string) => void;
}

/** Place a selected commit near the middle of the visible history viewport. */
export function historyStartForCommit(
  commitIndex: number,
  hasWorkingChanges: boolean,
  contentHeight: number,
  totalCommits: number,
): number {
  const rows = Math.max(1, contentHeight - 2);
  const leadingWorkingRow = hasWorkingChanges ? 1 : 0;
  const selectedRow = commitIndex + leadingWorkingRow;
  const totalRows = totalCommits + leadingWorkingRow;
  return Math.max(
    0,
    Math.min(Math.max(0, totalRows - rows), selectedRow - Math.floor(rows / 2)),
  );
}

export function moveCommit(context: RuntimeHistoryContext, delta: number) {
  if (!context.snapshot || context.commitDiffVisible) return;
  context.historyViewportDetached = false;
  const hasWorking = context.snapshot.files.length > 0;
  if (context.historySelection === "working") {
    if (delta <= 0) return;
    context.historySelection = "commit";
    context.commitIndex = 0;
  } else if (hasWorking && delta < 0 && context.commitIndex === 0) {
    context.historySelection = "working";
  } else {
    context.historySelection = "commit";
    context.commitIndex = Math.max(
      0,
      Math.min(
        context.snapshot.commits.length - 1,
        context.commitIndex + delta,
      ),
    );
  }
  context.paintHistory();
}

/**
 * Hide graph avatars until scrolling has been still for a moment. A scrollbar
 * drag keeps them hidden until release, so a pause mid-drag does not reload
 * every image.
 */
function markHistoryScrolling(context: RuntimeHistoryContext) {
  context.historyScrolling = true;
  if (context.scrollSettleTimer) clearTimeout(context.scrollSettleTimer);
  context.scrollSettleTimer = setTimeout(() => {
    context.scrollSettleTimer = undefined;
    if (context.historyScrollbarGrab) return;
    context.historyScrolling = false;
    // Restore graph avatars once the wheel burst has stopped. Replacing an
    // image in every visible row on every frame can saturate terminals that
    // implement the Kitty graphics protocol, including Ghostty.
    context.paintHistory();
  }, 80);
}

export function queueHistoryScroll(
  context: RuntimeHistoryContext,
  delta: number,
) {
  context.pendingScroll += delta;
  markHistoryScrolling(context);
  if (context.scrollTimer) return;
  context.scrollTimer = setTimeout(() => {
    const movement = context.pendingScroll;
    context.pendingScroll = 0;
    context.scrollTimer = undefined;
    scrollHistoryViewport(context, movement);
  }, 16);
}

export function scrollHistoryViewport(
  context: RuntimeHistoryContext,
  delta: number,
) {
  if (!context.snapshot) return;
  const hasWorking = context.snapshot.files.length > 0;
  const lines = Math.max(1, context.contentHeight - 2);
  const total =
    context.graphRowCount + (context.snapshot.files.length > 0 ? 1 : 0);
  const reserved = hasWorking && context.historyStart === 0 ? 1 : 0;
  const visible = Math.max(1, lines - reserved);
  context.historyViewportDetached = true;
  context.historyStart = Math.max(
    0,
    Math.min(Math.max(0, total - visible), context.historyStart + delta),
  );
  context.paintHistory();
}

/** Rows the history scrollbar covers, using the same counts as painting. */
function historyScrollbarRows(context: RuntimeHistoryContext) {
  const hasWorking = (context.snapshot?.files.length ?? 0) > 0;
  return {
    total: context.graphRowCount + (hasWorking ? 1 : 0),
    viewport: Math.max(1, context.contentHeight - 2),
  };
}

/**
 * Start a scrollbar drag when a left press lands on the scrollbar column.
 * `y` is pane-relative; the header takes line 0. Returns whether the press was
 * taken.
 */
export function pressHistoryScrollbar(
  context: RuntimeHistoryContext,
  x: number,
  y: number,
  button: number,
): boolean {
  if (button !== MouseButton.LEFT || !context.snapshot) return false;
  if (x !== context.historyContentLeft + context.historyContentWidth - 1)
    return false;
  const { total, viewport } = historyScrollbarRows(context);
  const pointer = y - 1;
  if (total <= viewport || pointer < 0 || pointer >= viewport) return false;
  if (context.scrollTimer) clearTimeout(context.scrollTimer);
  context.scrollTimer = undefined;
  context.pendingScroll = 0;
  context.historyScrollbarGrab = scrollbarGrab(
    total,
    context.historyStart,
    viewport,
    pointer,
  );
  markHistoryScrolling(context);
  dragHistoryScrollbar(context, y);
  return true;
}

/** Move the history viewport with the pointer. Returns whether a drag is active. */
export function dragHistoryScrollbar(
  context: RuntimeHistoryContext,
  y: number,
): boolean {
  const grab = context.historyScrollbarGrab;
  if (!grab) return false;
  const { total, viewport } = historyScrollbarRows(context);
  const next = scrollbarDrag(
    grab,
    total,
    context.historyStart,
    viewport,
    y - 1,
  );
  context.historyScrollbarGrab = next.grab;
  context.historyViewportDetached = true;
  if (next.start === context.historyStart) return true;
  context.historyStart = next.start;
  context.paintHistory();
  return true;
}

export function releaseHistoryScrollbar(context: RuntimeHistoryContext) {
  if (!context.historyScrollbarGrab) return;
  context.historyScrollbarGrab = undefined;
  // Start the settle delay that restores avatars.
  markHistoryScrolling(context);
}

/**
 * Map a clicked history line to a commit row.
 *
 * The first body line is the working row when it is on screen; every commit
 * owns one line after it.
 */
export function commitRowAtLine(
  bodyLine: number,
  start: number,
  hasWorking: boolean,
): number {
  if (bodyLine < 0) return -1;
  if (hasWorking && start === 0 && bodyLine === 0) return -1;
  const commitLine = bodyLine - (hasWorking && start === 0 ? 1 : 0);
  if (commitLine < 0) return -1;
  const base = start - (hasWorking && start > 0 ? 1 : 0);
  return base + commitLine;
}

export function historyClick(
  context: RuntimeHistoryContext,
  x: number,
  y: number,
  button: number,
) {
  context.setFocus("history");
  if (context.scrollTimer) clearTimeout(context.scrollTimer);
  context.scrollTimer = undefined;
  context.pendingScroll = 0;
  context.historyViewportDetached = false;
  const hasWorking = (context.snapshot?.files.length ?? 0) > 0;
  // The header occupies the first line, followed by one line per row.
  const row = commitRowAtLine(y - 1, context.historyStart, hasWorking);
  if (hasWorking && context.historyStart === 0 && y - 1 === 0) {
    context.diffOrigin = undefined;
    context.closeDiff();
    context.mode = "unstaged";
    context.paint();
    return;
  }
  if (row < 0 || row >= (context.snapshot?.commits.length ?? 0)) return;
  context.commitIndex = row;
  context.historySelection = "commit";
  context.paintHistory();
  const commit = context.snapshot!.commits[row]!;
  const column = x - context.historyContentLeft;
  const labelHit = context.historyLabelHits.get(row);
  const onLabel =
    !!labelHit && column >= labelHit.start && column < labelHit.end;
  if (button === MouseButton.RIGHT) {
    context.openGraphMenu(x, y + context.paneTop, {
      sha: commit.sha,
      branch: onLabel ? labelHit?.ref : undefined,
      tag: onLabel ? primaryDecorationTag(commit.decorations) : undefined,
      stash: context.snapshot?.stashes.find(
        (stash) => stash.sha === commit.sha,
      ),
    });
    return;
  }
  const shaHit = context.historyShaHits.get(row);
  if (shaHit && column >= shaHit.start && column < shaHit.end) {
    const sha = shortSha(commit.sha);
    if (context.renderer.copyToClipboardOSC52(sha))
      context.notify(`Copied ${sha}`);
    return;
  }
  const now = Date.now();
  const previous = context.lastGraphClick;
  context.lastGraphClick = { row, at: now, label: onLabel };
  const doubled =
    !!previous &&
    previous.row === row &&
    previous.label === onLabel &&
    now - previous.at < context.doubleClickMs;
  if (doubled) {
    context.lastGraphClick = undefined;
    if (onLabel && labelHit?.ref)
      return void context.checkoutBranch(labelHit.ref);
    if (onLabel) return context.notify("That label is a tag, not a branch");
  }
  void context.openCommit();
}
