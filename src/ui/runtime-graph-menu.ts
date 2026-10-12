// Graph context menu: open it for a target and run the chosen action.
import { shortSha } from "./history.js";
import {
  buildGraphMenu,
  type GraphMenuAction,
  type GraphMenuItem,
  type GraphMenuTarget,
} from "./graph-menu.js";
import {
  runMenuAction as runCommandMenuAction,
  type RuntimeCommandsContext,
} from "./runtime-commands.js";
import { openComparison, type RuntimeDataContext } from "./runtime-data.js";
import type { RuntimeFileHistoryController } from "./runtime-file-history.js";

/**
 * Menu actions fall through to the Git-backed commands, and comparison
 * actions open a diff, so the context joins both of their contexts.
 */
export type RuntimeGraphMenuContext = RuntimeCommandsContext &
  RuntimeDataContext &
  RuntimeGraphMenuMembers;

interface RuntimeGraphMenuMembers {
  readonly history: { title?: string };
  readonly fileHistory: Pick<
    RuntimeFileHistoryController,
    "showFile" | "showLine" | "showBlame"
  >;
  branchFilterActive: boolean;
  finishBranchFilter(): void;
  paintHistory(): void;
  openPopup(
    title: string,
    items: GraphMenuItem[],
    x: number,
    y: number,
    select: (item: GraphMenuItem) => void,
  ): void;
}

/** Open the graph context menu at a terminal position. */
export function openGraphMenu(
  context: RuntimeGraphMenuContext,
  x: number,
  y: number,
  target: GraphMenuTarget,
) {
  if (!context.snapshot) return;
  if (context.branchFilterActive) context.finishBranchFilter();
  const built = buildGraphMenu(
    target,
    context.snapshot,
    context.comparisonStartSha,
  );
  context.openPopup(built.title, built.items, x, y, (item) => {
    if (item.action) void runMenuAction(context, item.action, target);
  });
}

/**
 * Run a menu action. View actions (history, blame, comparison) happen here;
 * the rest go to the Git-backed commands.
 */
export function runMenuAction(
  context: RuntimeGraphMenuContext,
  action: GraphMenuAction,
  target: GraphMenuTarget,
) {
  const sha = target.sha || undefined;
  if (action === "file-history") {
    if (target.file) void context.fileHistory.showFile(target.file, sha);
    return;
  }
  if (action === "blame-line") {
    if (target.file && target.line !== undefined)
      void context.fileHistory.showBlame(target.file.path, target.line, sha);
    return;
  }
  if (action === "line-history") {
    if (target.file && target.line !== undefined)
      void context.fileHistory.showLine(target.file, target.line, sha);
    return;
  }
  if (action === "select-comparison-start") {
    context.comparisonStartSha = target.sha;
    context.history.title = ` Comparison start: ${shortSha(target.sha)} `;
    context.paintHistory();
    context.notify(
      `Comparison start: ${shortSha(target.sha)} · right-click another commit`,
    );
    return;
  }
  if (action === "clear-comparison-start") {
    context.comparisonStartSha = undefined;
    context.history.title = undefined;
    context.paintHistory();
    context.notify("Comparison start cleared");
    return;
  }
  if (action === "compare-with-selected") {
    const base = context.comparisonStartSha;
    if (!base || base === target.sha) return;
    const index = context.snapshot?.commits.findIndex(
      (commit) => commit.sha === target.sha,
    );
    if (index !== undefined && index >= 0) context.commitIndex = index;
    return openComparison(context, base);
  }
  return runCommandMenuAction(context, action, target);
}
