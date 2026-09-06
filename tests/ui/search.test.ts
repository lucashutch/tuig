import { describe, expect, test } from "bun:test";
import type { Commit } from "../../src/git/types.js";
import { DEFAULT_HISTORY_PAGE } from "../../src/git/repository.js";
import { SEARCH_PAGE, searchGraphRows } from "../../src/ui/search.js";

function commit(overrides: Partial<Commit>): Commit {
  return {
    sha: "0123456789abcdef",
    parents: [],
    author: "Ada Lovelace",
    authorEmail: "ada@example.com",
    authoredAt: "2020-01-01T00:00:00+00:00",
    committer: "Ada Lovelace",
    committerEmail: "ada@example.com",
    committedAt: "2020-01-01T00:00:00+00:00",
    subject: "Fix the parser",
    body: "Closes #42",
    decorations: ["refs/heads/feature/parser"],
    ...overrides,
  };
}

describe("search result rows", () => {
  test("uses the history page size for result records", () => {
    expect(SEARCH_PAGE).toBe(DEFAULT_HISTORY_PAGE);
    expect(SEARCH_PAGE).toBeGreaterThan(0);
  });

  test("supports graph viewport accessors", () => {
    const [row] = searchGraphRows([commit({})]);
    expect(row!.cellCount).toBe(1);
    expect(row!.connectorCount).toBe(0);
    expect(row!.colorAt(0)).toBe(row!.cells[0]!.color);
    expect(row!.laneColors).toEqual([row!.colorAt(0)!]);
    expect(row!.colorAt(-1)).toBeUndefined();
    expect(row!.colorAt(1)).toBeUndefined();
    expect(searchGraphRows([])).toEqual([]);
  });

  test("draws one dot per match and marks HEAD", () => {
    const rows = searchGraphRows(
      [commit({ sha: "aaa" }), commit({ sha: "bbb" })],
      "bbb",
    );
    expect(rows.map((row) => row.lane)).toEqual([0, 0]);
    // Matches are scattered through history, so nothing connects the rows.
    expect(rows.every((row) => row.connectors.length === 0)).toBe(true);
    expect(rows.every((row) => !row.continuesAbove)).toBe(true);
    expect(rows[0]!.cells[0]!.symbol).toBe("\u25cf ");
    expect(rows[1]!.cells[0]!.symbol).toBe("\u25c9 ");
    expect(rows[1]!.head).toBe(true);
  });
});
