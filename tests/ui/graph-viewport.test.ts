import { describe, expect, test } from "bun:test";
import type { GraphCell } from "../../src/ui/graph.js";
import {
  clampGraphScroll,
  graphWindowCells,
  laneVisible,
  visibleGraphColumns,
} from "../../src/ui/graph-viewport.js";

const cells = (count: number): GraphCell[] =>
  Array.from({ length: count }, (_, index) => ({
    symbol: `${index}`.padEnd(2),
    color: "#ffffff",
  }));

describe("visibleGraphColumns", () => {
  test("shows every lane while the graph fits its share of the pane", () => {
    expect(visibleGraphColumns(4, 120, 20)).toBe(4);
  });

  test("stops expanding once the graph would crowd the row", () => {
    expect(visibleGraphColumns(40, 120, 20)).toBe(17);
  });

  test("keeps a usable minimum in a narrow pane", () => {
    expect(visibleGraphColumns(40, 30, 20)).toBe(3);
  });
});

describe("clampGraphScroll", () => {
  test("cannot pan past the hidden lanes", () => {
    expect(clampGraphScroll(99, 10, 4)).toBe(6);
    expect(clampGraphScroll(-3, 10, 4)).toBe(0);
    expect(clampGraphScroll(2, 4, 4)).toBe(0);
  });
});

describe("graphWindowCells", () => {
  test("keeps a constant width and marks hidden lanes", () => {
    const window = graphWindowCells(cells(10), 3, 4, 10, "#888888");
    expect(window.cells).toHaveLength(4);
    expect(window.hiddenLeft).toBe(3);
    expect(window.hiddenRight).toBe(3);
    expect(window.cells[0]!.symbol).toBe("◂ ");
    expect(window.cells[3]!.symbol).toBe(" ▸");
    expect(window.cells[1]!.symbol.trim()).toBe("4");
  });

  test("pads short rows out to the window", () => {
    const window = graphWindowCells(cells(2), 0, 5, 5, "#888888");
    expect(window.cells).toHaveLength(5);
    expect(window.cells[4]!.symbol).toBe("  ");
    expect(window.hiddenLeft).toBe(0);
    expect(window.hiddenRight).toBe(0);
  });
});

describe("laneVisible", () => {
  test("excludes lanes outside the window or under a marker", () => {
    expect(laneVisible(5, 3, 4, 10)).toBe(true);
    expect(laneVisible(3, 3, 4, 10)).toBe(false);
    expect(laneVisible(6, 3, 4, 10)).toBe(false);
    expect(laneVisible(0, 3, 4, 10)).toBe(false);
    expect(laneVisible(0, 0, 4, 4)).toBe(true);
  });
});
