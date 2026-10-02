import { visibleGraphColumns } from "./graph-viewport.js";

/** The header separators that resize a column when dragged. */
export type HistoryDividerKey = "branchWidth" | "graphWidth" | "committerWidth";

export interface HistoryColumns {
  branchWidth?: number;
  graphWidth?: number;
  committerWidth?: number;
  showCommitter: boolean;
  showSha: boolean;
}

const MIN_MESSAGE_WIDTH = 10;

/** Shared geometry for painting and header drag hit testing. */
export function historyColumnLayout(
  width: number,
  lanes: number,
  prefs: HistoryColumns,
) {
  const branchWidth = Math.max(
    4,
    Math.min(
      prefs.branchWidth ?? Math.min(22, Math.max(14, Math.floor(width * 0.28))),
      Math.max(4, width - 40),
    ),
  );
  // The message column takes whatever the others leave, so no drag can leave
  // empty space beside the SHA column. Reserve room for the separators, the
  // scrollbar, a minimal graph, and a readable message.
  const shaWidth = prefs.showSha ? 11 : 0;
  const committerMax = Math.max(
    6,
    width - branchWidth - 2 - 5 - 3 - MIN_MESSAGE_WIDTH - 3 - shaWidth - 1,
  );
  const committerWidth = prefs.showCommitter
    ? Math.max(6, Math.min(prefs.committerWidth ?? 11, committerMax))
    : 0;
  const metadataWidth =
    (prefs.showCommitter ? committerWidth + 3 : 0) + shaWidth;
  const graphWidth = Math.max(
    5,
    Math.min(
      prefs.graphWidth ??
        Math.max(5, visibleGraphColumns(lanes, width, branchWidth) * 2),
      Math.max(
        5,
        width - branchWidth - metadataWidth - 2 - 3 - MIN_MESSAGE_WIDTH - 1,
      ),
    ),
  );
  const graphColumns = Math.max(1, Math.min(lanes, Math.floor(graphWidth / 2)));
  const messageStart = branchWidth + 2 + graphWidth + 3;
  const messageWidth = Math.max(1, width - messageStart - metadataWidth - 1);
  const messageEnd = messageStart + messageWidth;
  const shaStart =
    messageEnd +
    (prefs.showCommitter ? committerWidth + 3 : 0) +
    (prefs.showSha ? 3 : 0);
  return {
    branchWidth,
    graphColumns,
    graphWidth,
    messageStart,
    messageWidth,
    messageEnd,
    committerWidth,
    shaStart,
  };
}

export function historyDividerAt(
  column: number,
  layout: ReturnType<typeof historyColumnLayout>,
): HistoryDividerKey | undefined {
  if (column >= layout.branchWidth && column < layout.branchWidth + 2)
    return "branchWidth";
  if (column >= layout.messageStart - 3 && column < layout.messageStart)
    return "graphWidth";
  if (
    layout.committerWidth > 0 &&
    column >= layout.messageEnd &&
    column < layout.messageEnd + 3
  )
    return "committerWidth";
  return undefined;
}

/** Whether a press on a header separator completes a double click on it. */
export function isDividerDoubleClick(
  previous: { key: HistoryDividerKey; at: number } | undefined,
  key: HistoryDividerKey,
  now: number,
  windowMs: number,
): boolean {
  return previous?.key === key && now - previous.at < windowMs;
}
