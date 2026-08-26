import type { Commit } from "../git/types.js";

export interface GraphCell {
  symbol: string;
  color: string;
}
export interface GraphRow {
  commit: Commit;
  lane: number;
  /** True for the commit HEAD currently points at. */
  head: boolean;
  cells: GraphCell[];
  connectors: GraphCell[];
  laneColors: string[];
}

// A graph character is chosen only after routes have been described.  Keeping
// this separate from layout makes crossings deterministic rather than relying
// on whichever connector happened to be drawn last.
const enum Direction {
  North = 1,
  East = 2,
  South = 4,
  West = 8,
}
type Topology = {
  mask: number;
  commit?: boolean;
  head?: boolean;
};

function add(topology: Topology[], lane: number, direction: Direction) {
  topology[lane] ??= { mask: 0 };
  topology[lane]!.mask |= direction;
}

/** Removes a stroke a lane only inherited, e.g. a column created on this row. */
function clear(topology: Topology[], lane: number, direction: Direction) {
  topology[lane] ??= { mask: 0 };
  topology[lane]!.mask &= ~direction;
}

// Every glyph is chosen from the strokes that actually reach the cell, so a
// lane which both continues vertically and receives a horizontal run joins it
// (┬ ┴ ├ ┤ ┼) instead of being drawn as a corner that leaves a visible gap.
const GLYPHS = new Map<number, string>([
  [Direction.North | Direction.South | Direction.East | Direction.West, "┼"],
  [Direction.North | Direction.East | Direction.West, "┴"],
  [Direction.South | Direction.East | Direction.West, "┬"],
  [Direction.North | Direction.South | Direction.East, "├"],
  [Direction.North | Direction.South | Direction.West, "┤"],
  [Direction.North | Direction.East, "╰"],
  [Direction.North | Direction.West, "╯"],
  [Direction.South | Direction.East, "╭"],
  [Direction.South | Direction.West, "╮"],
  [Direction.North | Direction.South, "│"],
  [Direction.North, "│"],
  [Direction.South, "│"],
  [Direction.East, "─"],
  [Direction.West, "─"],
  [Direction.East | Direction.West, "─"],
]);

function symbol(topology: Topology | undefined): string {
  if (!topology) return "  ";
  const { mask, commit, head } = topology;
  const trailing = mask & Direction.East ? "─" : " ";
  // HEAD gets its own dot so the checked-out commit is findable without
  // reading any of the row's text.
  const dot = head ? "◉" : "●";
  return (commit ? dot : (GLYPHS.get(mask) ?? " ")) + trailing;
}

/** Assigns persistent lanes in newest-first log order. */
export function layoutGraph(
  commits: readonly Commit[],
  colors: readonly string[],
  headSha?: string,
): GraphRow[] {
  const active: string[] = [];
  // Colors belong to an ancestry, not a column.  Inserting or deleting a lane
  // must therefore not recolor an unrelated line.
  const activeColors: string[] = [];
  let nextColor = 0;
  const color = () =>
    colors[nextColor++ % Math.max(1, colors.length)] ?? "#888888";

  return commits.map((commit) => {
    let incoming = active.flatMap((sha, index) =>
      sha === commit.sha ? [index] : [],
    );
    let lane = incoming[0] ?? -1;
    if (lane < 0) {
      // An exhausted lane is removed immediately, so this append is also safe
      // reuse of its column (and preserves first-parent continuity otherwise).
      lane = active.length;
      active.push(commit.sha);
      activeColors.push(color());
      incoming = [lane];
    }

    const before = [...active];
    const beforeColors = [...activeColors];
    const parents = commit.parents.filter(
      (parent, index, all) => parent && all.indexOf(parent) === index,
    );

    // Replace the first (and therefore first-parent) occurrence in place. A
    // later duplicate is retained until its commit is drawn, where it becomes
    // an explicit fan-in rather than an accidental overwritten line.
    active.splice(lane, 1, ...parents);
    activeColors.splice(
      lane,
      1,
      ...parents.map((_, index) =>
        index === 0 ? (beforeColors[lane] ?? color()) : color(),
      ),
    );
    for (let index = before.length - 1; index > lane; index--) {
      if (before[index] === commit.sha) {
        active.splice(index + parents.length - 1, 1);
        activeColors.splice(index + parents.length - 1, 1);
      }
    }

    const width = Math.max(before.length, active.length, lane + 1);
    const cellTopology: Topology[] = Array.from(
      { length: width },
      (_, column) =>
        column < before.length || column < active.length
          ? { mask: Direction.North | Direction.South }
          : { mask: 0 },
    );
    const isHead = commit.sha === headSha;
    cellTopology[lane] = { mask: Direction.South, commit: true, head: isHead };

    // Multiple incoming copies of a commit meet on its dot.  Existing vertical
    // lanes retain their N/S mask, yielding a stable crossing at intersections.
    if (incoming.length > 1) {
      const last = incoming.at(-1)!;
      add(cellTopology, lane, Direction.East);
      for (let column = lane + 1; column <= last; column++) {
        // These copies arrive from above and end here; they are not continuing
        // lanes, so drop the south half of their inherited vertical stroke.
        if (incoming.includes(column))
          cellTopology[column]!.mask = Direction.North;
        add(cellTopology, column, Direction.West);
        if (column < last) add(cellTopology, column, Direction.East);
      }
    }

    const connectorTopology: Topology[] = Array.from(
      { length: Math.max(width, active.length) },
      (_, column) =>
        column < active.length
          ? { mask: Direction.North | Direction.South }
          : { mask: 0 },
    );
    if (parents.length > 1) {
      add(connectorTopology, lane, Direction.East);
      for (let column = lane + 1; column < lane + parents.length; column++) {
        // These lanes are created by this row: they start at the horizontal
        // run and descend from it, so they must not inherit a north stroke.
        clear(connectorTopology, column, Direction.North);
        add(connectorTopology, column, Direction.West);
        if (column < lane + parents.length - 1)
          add(connectorTopology, column, Direction.East);
      }
    } else if (parents[0]) {
      const parentLane = active.indexOf(parents[0]);
      if (parentLane >= 0 && parentLane < lane) {
        add(connectorTopology, parentLane, Direction.East);
        for (let column = parentLane + 1; column <= lane; column++) {
          add(connectorTopology, column, Direction.West);
          if (column < lane) add(connectorTopology, column, Direction.East);
        }
      }
    }

    const makeCells = (topology: Topology[], useBefore = false) =>
      topology.map(
        (node, column): GraphCell => ({
          symbol: symbol(node),
          color:
            (column === lane && useBefore
              ? beforeColors[column]
              : useBefore
                ? beforeColors[column]
                : activeColors[column]) ?? "#888888",
        }),
      );
    const cells = makeCells(cellTopology, true);
    return {
      commit,
      lane,
      head: isHead,
      cells,
      connectors: makeCells(connectorTopology),
      laneColors: cells.map((cell) => cell.color),
    };
  });
}
