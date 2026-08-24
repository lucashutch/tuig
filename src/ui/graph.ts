import type { Commit } from "../git/types.js";

export interface GraphCell {
  symbol: string;
  color: string;
}
export interface GraphRow {
  commit: Commit;
  lane: number;
  cells: GraphCell[];
  connectors: GraphCell[];
  laneColors: string[];
}

/** Assigns persistent lanes in newest-first log order. */
export function layoutGraph(
  commits: readonly Commit[],
  colors: readonly string[],
): GraphRow[] {
  const active: string[] = [];
  // Keep colors attached to ancestry rather than to a column.  Columns move
  // when a side lane is inserted/removed, but the line representing that
  // ancestry must not change color (otherwise a long-running lane appears to
  // have gaps at every such move).
  const activeColors: string[] = [];
  let nextColor = 0;
  return commits.map((commit) => {
    let incomingLanes = active
      .map((sha, index) => (sha === commit.sha ? index : -1))
      .filter((index) => index >= 0);
    let lane = incomingLanes[0] ?? -1;
    if (lane < 0) {
      lane = active.length;
      active.push(commit.sha);
      activeColors.push(
        colors[nextColor++ % Math.max(1, colors.length)] ?? "#888888",
      );
      incomingLanes = [lane];
    }
    const before = [...active];
    const beforeColors = [...activeColors];
    const parents = commit.parents.filter(
      (parent, index, all) => parent && all.indexOf(parent) === index,
    );
    active.splice(lane, 1, ...parents);
    const parentColors = parents.map((_, index) =>
      index === 0
        ? (beforeColors[lane] ??
          colors[lane % Math.max(1, colors.length)] ??
          "#888888")
        : (colors[nextColor++ % Math.max(1, colors.length)] ?? "#888888"),
    );
    activeColors.splice(lane, 1, ...parentColors);
    for (let index = before.length - 1; index > lane; index--)
      if (before[index] === commit.sha) {
        active.splice(index + parents.length - 1, 1);
        activeColors.splice(index + parents.length - 1, 1);
      }
    const width = Math.max(before.length, active.length, lane + 1);
    const cells = Array.from(
      { length: width },
      (_, column): GraphCell => ({
        symbol:
          column === lane
            ? "● "
            : column < before.length || column < active.length
              ? "│ "
              : "  ",
        color:
          (column === lane
            ? beforeColors[column]
            : (beforeColors[column] ?? activeColors[column])) ?? "#888888",
      }),
    );
    const connectors = Array.from(
      { length: Math.max(width, active.length) },
      (_, column): GraphCell => ({
        symbol: column < active.length ? "│ " : "  ",
        color: activeColors[column] ?? "#888888",
      }),
    );
    if (parents.length > 1) {
      connectors[lane]!.symbol = "├─";
      for (let column = lane + 1; column < lane + parents.length - 1; column++)
        if (connectors[column]) connectors[column]!.symbol = "──";
      if (connectors[lane + parents.length - 1])
        connectors[lane + parents.length - 1]!.symbol = "╮ ";
    } else if (parents[0]) {
      const parentLane = active.indexOf(parents[0]);
      if (parentLane >= 0 && parentLane < lane) {
        connectors[parentLane]!.symbol = "╭─";
        for (let column = parentLane + 1; column < lane; column++)
          if (connectors[column])
            connectors[column]!.symbol = active[column] ? "┼─" : "──";
        if (connectors[lane]) connectors[lane]!.symbol = "╯ ";
      }
    }
    if (incomingLanes.length > 1) {
      const last = incomingLanes.at(-1)!;
      for (let column = lane; column <= last; column++) {
        if (column === lane) cells[column]!.symbol = "●─";
        else if (incomingLanes.includes(column))
          // The lanes are already joined by the single horizontal stroke.
          // Do not draw a second (overlapping) fan-out at intermediate
          // children; the only branch marker is the terminal turn.
          cells[column]!.symbol = column === last ? "╯ " : "──";
        else cells[column]!.symbol = before[column] ? "┼─" : "──";
      }
    }
    return {
      commit,
      lane,
      cells,
      connectors,
      laneColors: cells.map((cell) => cell.color),
    };
  });
}
