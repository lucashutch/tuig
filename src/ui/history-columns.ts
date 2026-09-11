import { visibleGraphColumns } from "./graph-viewport.js";

export interface HistoryColumns {
  branchWidth?: number;
  graphWidth?: number;
  messageWidth?: number;
  showCommitter: boolean;
  showSha: boolean;
}

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
  const committerWidth = prefs.showCommitter ? 11 : 0;
  const metadataWidth =
    (prefs.showCommitter ? committerWidth + 3 : 0) + (prefs.showSha ? 11 : 0);
  const graphWidth = Math.max(
    5,
    Math.min(
      prefs.graphWidth ??
        Math.max(5, visibleGraphColumns(lanes, width, branchWidth) * 2),
      // Keep space for the separators, scrollbar, and a readable message.
      Math.max(5, width - branchWidth - metadataWidth - 14),
    ),
  );
  const graphColumns = Math.max(1, Math.min(lanes, Math.floor(graphWidth / 2)));
  const messageStart = branchWidth + 2 + graphWidth + 3;
  const maxMessageWidth = Math.max(1, width - messageStart - metadataWidth - 1);
  const messageWidth = Math.max(
    1,
    Math.min(prefs.messageWidth ?? maxMessageWidth, maxMessageWidth),
  );
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
    padding: Math.max(0, maxMessageWidth - messageWidth),
  };
}

export function historyDividerAt(
  column: number,
  layout: ReturnType<typeof historyColumnLayout>,
): "branchWidth" | "graphWidth" | "messageWidth" | undefined {
  if (column >= layout.branchWidth && column < layout.branchWidth + 2)
    return "branchWidth";
  if (column >= layout.messageStart - 3 && column < layout.messageStart)
    return "graphWidth";
  if (column >= layout.messageEnd && column < layout.messageEnd + 3)
    return "messageWidth";
  return undefined;
}
