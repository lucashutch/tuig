import type { Commit } from "../git/types.js";
import {
  emptyGraphLayoutState,
  layoutGraphFrom,
  type GraphLayoutState,
  type GraphRow,
} from "./graph.js";

/**
 * Rows between saved lane states.
 *
 * Replaying a screenful costs the layout of everything from the preceding
 * checkpoint, so this is the width of the worst paint. At 500 it measured
 * 0.71ms on average and 3.54ms at worst over 150 cold paints of a
 * 116000-commit log, against a 16ms frame. Wider strides save little: the
 * checkpoints for that log are 232 lane states, tens of kilobytes in total.
 */
export const CHECKPOINT_STRIDE = 500;

/**
 * Lane layout for a loaded history, without the rows.
 *
 * Laying out the graph is a forward fold, so the lane state at row N is enough
 * to produce every row after it. Keeping one state per 500 rows and replaying
 * the visible window on demand costs about 1ms a paint and saves holding a row
 * per commit: on a 116000-commit repository the retained rows were 83MB, about
 * 750 bytes per commit, mostly packed cell strings that JavaScriptCore stores
 * 16-bit because they contain box-drawing characters.
 */
export interface GraphIndex {
  /** Rows laid out so far, which tracks the loaded commit count. */
  length: number;
  /** Widest row seen, so every painted row is padded to one column count. */
  columns: number;
  /** Lane state before row `i * CHECKPOINT_STRIDE`. */
  readonly checkpoints: GraphLayoutState[];
  /** Lane state after row `length`, which the next page continues from. */
  state: GraphLayoutState;
  /** HEAD when the index was built, since it marks a row as the head row. */
  headSha?: string;
  /** The last window replayed, so repeated paints do not replay it again. */
  window?: { from: number; rows: GraphRow[] };
}

export function emptyGraphIndex(): GraphIndex {
  return {
    length: 0,
    columns: 1,
    checkpoints: [emptyGraphLayoutState],
    state: emptyGraphLayoutState,
  };
}

/** Widest of `rows`, folded into a running count. */
function widest(rows: readonly GraphRow[], columns: number): number {
  for (const row of rows)
    columns = Math.max(columns, row.cellCount, row.connectorCount);
  return columns;
}

/**
 * Lay out every commit past the end of the index.
 *
 * The rows produced here are thrown away. Only the lane state at each stride
 * boundary and the widest row are kept, which is what lets the window be
 * replayed later.
 */
export function extendGraphIndex(
  index: GraphIndex,
  commits: readonly Commit[],
  colors: readonly string[],
  headSha?: string,
): void {
  // The fold only runs forwards. A shorter list is a different history, which
  // belongs in a fresh index rather than half of this one.
  if (commits.length < index.length)
    throw new Error(
      `graph index holds ${index.length} rows, cannot extend with ${commits.length} commits`,
    );
  index.headSha = headSha;
  index.window = undefined;
  let at = index.length;
  while (at < commits.length) {
    // Laid out a stride at a time so a checkpoint lands exactly on each
    // boundary, whatever page size the commits arrived in.
    const boundary =
      (Math.floor(at / CHECKPOINT_STRIDE) + 1) * CHECKPOINT_STRIDE;
    const upto = Math.min(commits.length, boundary);
    const laidOut = layoutGraphFrom(
      commits.slice(at, upto),
      colors,
      headSha,
      index.state,
    );
    index.state = laidOut.state;
    index.columns = widest(laidOut.rows, index.columns);
    at = upto;
    if (at % CHECKPOINT_STRIDE === 0)
      index.checkpoints[at / CHECKPOINT_STRIDE] = laidOut.state;
  }
  index.length = at;
}

/**
 * Rows `from` through `from + count`, replayed from the nearest checkpoint.
 *
 * The returned array may be longer than `count`; it is owned by the index and
 * must not be modified.
 */
export function graphWindow(
  index: GraphIndex,
  commits: readonly Commit[],
  colors: readonly string[],
  from: number,
  count: number,
): readonly GraphRow[] {
  if (from < 0 || count <= 0 || from >= index.length) return [];
  const held = index.window;
  if (
    held &&
    held.from === from &&
    held.rows.length >= Math.min(count, index.length - from)
  )
    return held.rows;
  const mark = Math.floor(from / CHECKPOINT_STRIDE);
  const base = mark * CHECKPOINT_STRIDE;
  const upto = Math.min(index.length, from + count);
  const laidOut = layoutGraphFrom(
    commits.slice(base, upto),
    colors,
    index.headSha,
    index.checkpoints[mark],
  );
  const rows = laidOut.rows.slice(from - base);
  index.window = { from, rows };
  return rows;
}
