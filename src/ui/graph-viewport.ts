import type { GraphCell } from "./graph.js";

/** Columns the graph keeps even in a very narrow history pane. */
export const MIN_GRAPH_COLUMNS = 3;

/**
 * Share of the history pane the graph may occupy before it stops growing.
 *
 * Repositories with many parallel branches produce very wide graphs, and a
 * graph that keeps expanding pushes the subject, author, and sha off the row.
 * Past this share the graph becomes a horizontally scrollable window instead.
 */
const GRAPH_WIDTH_SHARE = 0.35;

/** Columns the graph window shows for a given history width. */
export function visibleGraphColumns(
  totalColumns: number,
  historyContentWidth: number,
  labelWidth: number,
): number {
  const total = Math.max(1, Math.trunc(totalColumns));
  const available = Math.max(0, historyContentWidth - labelWidth - 2);
  const budget = Math.floor((available * GRAPH_WIDTH_SHARE) / 2);
  return Math.max(1, Math.min(total, Math.max(MIN_GRAPH_COLUMNS, budget)));
}

/** Clamp a horizontal graph offset to the scrollable range. */
export function clampGraphScroll(
  scroll: number,
  totalColumns: number,
  visibleColumns: number,
): number {
  const max = Math.max(
    0,
    Math.trunc(totalColumns) - Math.trunc(visibleColumns),
  );
  const value = Number.isFinite(scroll) ? Math.trunc(scroll) : 0;
  return Math.max(0, Math.min(max, value));
}

export interface GraphWindow {
  cells: GraphCell[];
  /** Columns hidden to the left and right of the window. */
  hiddenLeft: number;
  hiddenRight: number;
}

/**
 * Slice one row's cells to the visible window.
 *
 * The row width stays constant. The history header shows the only indicator
 * that lanes are hidden, so rows stay free of per-line markers.
 */
export function graphWindowCells(
  cells: readonly GraphCell[],
  scroll: number,
  visibleColumns: number,
  totalColumns: number,
  markerColor: string,
): GraphWindow {
  const visible = Math.max(1, Math.trunc(visibleColumns));
  const offset = clampGraphScroll(scroll, totalColumns, visible);
  const hiddenLeft = offset;
  const hiddenRight = Math.max(0, totalColumns - (offset + visible));
  const window: GraphCell[] = [];
  for (let column = offset; column < offset + visible; column++)
    window.push(cells[column] ?? { symbol: "  ", color: markerColor });
  return { cells: window, hiddenLeft, hiddenRight };
}

/** Whether a lane's dot is drawn inside the window. */
export function laneVisible(
  lane: number,
  scroll: number,
  visibleColumns: number,
  totalColumns: number,
): boolean {
  const visible = Math.max(1, Math.trunc(visibleColumns));
  const offset = clampGraphScroll(scroll, totalColumns, visible);
  if (lane < offset || lane >= offset + visible) return false;
  return true;
}

/**
 * Arrows for the graph column header: a fixed left slot and right slot, so an
 * arrow keeps its column as the graph pans. Empty when nothing is hidden.
 */
export function graphScrollIndicator(
  hiddenLeft: number,
  hiddenRight: number,
): string {
  if (hiddenLeft <= 0 && hiddenRight <= 0) return "";
  return `${hiddenLeft > 0 ? "◀" : " "} ${hiddenRight > 0 ? "▶" : " "}`;
}
