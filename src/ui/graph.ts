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
  /** Whether this ancestry enters the commit from the row above. */
  continuesAbove: boolean;
  readonly cells: GraphCell[];
  readonly connectors: GraphCell[];
  readonly laneColors: string[];
  /** Lane count without materialising `cells`. */
  readonly cellCount: number;
  /** Lane count without materialising `connectors`. */
  readonly connectorCount: number;
  /** One lane's color without materialising `cells`. */
  colorAt(lane: number): string | undefined;
}

// Every cell is two symbol characters plus one character holding an index into
// a palette shared by the whole layout.  A 100k-commit repository keeps tens of
// thousands of these rows alive, where an array of `{symbol, color}` objects
// cost 4.4kB per row against roughly 0.4kB packed; the arrays are rebuilt on
// access because only the ~50 painted rows ever ask for them.
const CELL_WIDTH = 3;

class PackedGraphRow implements GraphRow {
  constructor(
    readonly commit: Commit,
    readonly lane: number,
    readonly head: boolean,
    readonly continuesAbove: boolean,
    private readonly palette: readonly string[],
    private readonly cellData: string,
    private readonly connectorData: string,
  ) {}

  private unpack(data: string): GraphCell[] {
    const cells: GraphCell[] = [];
    for (let at = 0; at < data.length; at += CELL_WIDTH)
      cells.push({
        symbol: data.slice(at, at + 2),
        color: this.palette[data.charCodeAt(at + 2)] ?? FALLBACK_COLOR,
      });
    return cells;
  }

  get cells(): GraphCell[] {
    return this.unpack(this.cellData);
  }
  get connectors(): GraphCell[] {
    return this.unpack(this.connectorData);
  }
  get laneColors(): string[] {
    const colors: string[] = [];
    for (let at = 2; at < this.cellData.length; at += CELL_WIDTH)
      colors.push(this.palette[this.cellData.charCodeAt(at)] ?? FALLBACK_COLOR);
    return colors;
  }
  get cellCount(): number {
    return this.cellData.length / CELL_WIDTH;
  }
  get connectorCount(): number {
    return this.connectorData.length / CELL_WIDTH;
  }
  colorAt(lane: number): string | undefined {
    const at = lane * CELL_WIDTH + 2;
    if (lane < 0 || at >= this.cellData.length) return undefined;
    return this.palette[this.cellData.charCodeAt(at)] ?? FALLBACK_COLOR;
  }
}

const FALLBACK_COLOR = "#888888";

/** Interns colors so a row stores an index rather than a string per cell. */
class Palette {
  readonly colors: string[] = [];
  private readonly indices = new Map<string, number>();
  index(color: string): number {
    const known = this.indices.get(color);
    if (known !== undefined) return known;
    const next = this.colors.length;
    this.colors.push(color);
    this.indices.set(color, next);
    return next;
  }
}

function pack(cells: readonly GraphCell[], palette: Palette): string {
  const parts: string[] = [];
  for (const cell of cells)
    parts.push(cell.symbol, String.fromCharCode(palette.index(cell.color)));
  return parts.join("");
}

/**
 * Builds a row in the packed representation.  Tests and any future producer of
 * synthetic rows go through here rather than assigning the cell arrays.
 */
export function packGraphRow(row: {
  commit: Commit;
  lane: number;
  head: boolean;
  continuesAbove: boolean;
  cells: readonly GraphCell[];
  connectors: readonly GraphCell[];
}): GraphRow {
  const palette = new Palette();
  return new PackedGraphRow(
    row.commit,
    row.lane,
    row.head,
    row.continuesAbove,
    palette.colors,
    pack(row.cells, palette),
    pack(row.connectors, palette),
  );
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

/**
 * The fold state carried between `layoutGraphFrom` calls.  History is loaded a
 * page at a time, so appending must resume rather than re-fold the whole log.
 */
export interface GraphLayoutState {
  /** Lane occupancy: the sha each column is currently waiting for. */
  readonly active: readonly string[];
  // Colors belong to an ancestry, not a column.  Inserting or deleting a lane
  // must therefore not recolor an unrelated line.
  readonly activeColors: readonly string[];
  readonly nextColor: number;
}

export const emptyGraphLayoutState: GraphLayoutState = {
  active: [],
  activeColors: [],
  nextColor: 0,
};

/** Assigns persistent lanes in newest-first log order. */
export function layoutGraph(
  commits: readonly Commit[],
  colors: readonly string[],
  headSha?: string,
): GraphRow[] {
  return layoutGraphFrom(commits, colors, headSha).rows;
}

/**
 * Lays out `commits` as if they directly followed the commits that produced
 * `state`.  The incoming state is copied, so a caller may keep holding it.
 */
export function layoutGraphFrom(
  commits: readonly Commit[],
  colors: readonly string[],
  headSha?: string,
  state: GraphLayoutState = emptyGraphLayoutState,
): { rows: GraphRow[]; state: GraphLayoutState } {
  const active: string[] = [...state.active];
  const activeColors: string[] = [...state.activeColors];
  let nextColor = state.nextColor;
  const color = () =>
    colors[nextColor++ % Math.max(1, colors.length)] ?? FALLBACK_COLOR;
  // One palette serves every row of the call, seeded in theme order so a log
  // folded in two pages packs identically to the same log folded in one.
  const palette = new Palette();
  for (const entry of [...colors, FALLBACK_COLOR]) palette.index(entry);

  const rows = commits.map((commit) => {
    let incoming = active.flatMap((sha, index) =>
      sha === commit.sha ? [index] : [],
    );
    let lane = incoming[0] ?? -1;
    const continuesAbove = lane >= 0;
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

    const packCells = (topology: Topology[], useBefore = false) => {
      // Joined rather than appended: repeated `+=` leaves a rope holding every
      // fragment alive, which costs more than the objects being replaced.
      const parts: string[] = [];
      for (const [column, node] of topology.entries()) {
        const cellColor =
          (useBefore ? beforeColors[column] : activeColors[column]) ??
          FALLBACK_COLOR;
        parts.push(symbol(node), String.fromCharCode(palette.index(cellColor)));
      }
      return parts.join("");
    };
    return new PackedGraphRow(
      commit,
      lane,
      isHead,
      continuesAbove,
      palette.colors,
      packCells(cellTopology, true),
      packCells(connectorTopology),
    );
  });

  return { rows, state: { active, activeColors, nextColor } };
}
