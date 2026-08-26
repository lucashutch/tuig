import { MouseButton, type CliRenderer } from "@opentui/core";
import type { BranchRef, RepositorySnapshot, Stash } from "../git/types.js";
import type { GraphRow } from "./graph.js";
import { shortSha } from "./history.js";

export interface RuntimeHistoryContext {
  snapshot?: RepositorySnapshot;
  graphRows: GraphRow[];
  commitIndex: number;
  historySelection: "working" | "commit";
  historyStart: number;
  historyViewportDetached: boolean;
  historyContentLeft: number;
  contentHeight: number;
  pendingScroll: number;
  scrollTimer?: ReturnType<typeof setTimeout>;
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
    target: { sha: string; branch?: BranchRef; stash?: Stash },
  ) => void;
  closeDiff: () => void;
  checkoutBranch: (branch: BranchRef) => unknown;
  setFocus: (focus: "history" | "changes") => void;
  notify: (text: string) => void;
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

export function queueHistoryScroll(
  context: RuntimeHistoryContext,
  delta: number,
) {
  context.pendingScroll += delta;
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
  const total =
    context.graphRows.length + (context.snapshot.files.length > 0 ? 1 : 0);
  const visible = Math.max(1, context.contentHeight - 3);
  context.historyViewportDetached = true;
  context.historyStart = Math.max(
    0,
    Math.min(Math.max(0, total - visible), context.historyStart + delta),
  );
  context.paintHistory();
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
  const displayIndex = context.historyStart + y - 2;
  if (hasWorking && displayIndex === 0) {
    context.diffOrigin = undefined;
    context.closeDiff();
    context.mode = "unstaged";
    context.paint();
    return;
  }
  const row = displayIndex - (hasWorking ? 1 : 0);
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
      stash: onLabel
        ? context.snapshot?.stashes.find((stash) => stash.sha === commit.sha)
        : undefined,
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
