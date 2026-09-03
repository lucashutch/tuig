import { describe, expect, test } from "bun:test";
import type { Commit } from "../../src/git/types.js";
import { layoutGraph } from "../../src/ui/graph.js";
import {
  CHECKPOINT_STRIDE,
  emptyGraphIndex,
  extendGraphIndex,
  graphWindow,
} from "../../src/ui/graph-index.js";
import { oneDarkTheme } from "../../src/ui/theme.js";

const base = {
  author: "A",
  authorEmail: "a@b",
  authoredAt: "2026-01-01",
  committer: "C",
  committerEmail: "c@d",
  committedAt: "2026-01-01",
  subject: "x",
  body: "",
  decorations: [] as string[],
};
const commit = (sha: string, parents: string[]): Commit => ({
  ...base,
  sha,
  parents,
});

/** A history with merges and forks, so lanes open, cross and close. */
function history(size: number): Commit[] {
  const commits: Commit[] = [];
  for (let i = 0; i < size; i++) {
    const parents = [`c${i + 1}`];
    // Every seventh commit is a merge, which opens a lane that closes later.
    if (i % 7 === 0 && i + 4 < size) parents.push(`c${i + 4}`);
    commits.push(commit(`c${i}`, i + 1 < size ? parents : []));
  }
  return commits;
}

const colors = oneDarkTheme.graph;

describe("graph index", () => {
  test("replays every window to match a layout of the whole history", () => {
    const commits = history(CHECKPOINT_STRIDE * 3 + 137);
    const whole = layoutGraph(commits, colors);
    const index = emptyGraphIndex();
    extendGraphIndex(index, commits, colors);
    expect(index.length).toBe(commits.length);
    // Windows on and either side of a checkpoint, and one that spans two.
    for (const from of [
      0,
      1,
      CHECKPOINT_STRIDE - 1,
      CHECKPOINT_STRIDE,
      CHECKPOINT_STRIDE + 1,
      CHECKPOINT_STRIDE * 2 - 30,
      commits.length - 60,
    ])
      expect(
        graphWindow(index, commits, colors, from, 60).slice(0, 60),
      ).toEqual(whole.slice(from, from + 60));
  });

  test("reaches the same layout however the pages were sized", () => {
    const commits = history(CHECKPOINT_STRIDE * 2 + 40);
    const whole = layoutGraph(commits, colors);
    for (const page of [1, 17, 250, CHECKPOINT_STRIDE, 999]) {
      const index = emptyGraphIndex();
      for (let at = 0; at < commits.length; at += page)
        extendGraphIndex(index, commits.slice(0, at + page), colors);
      expect(index.length).toBe(commits.length);
      expect(graphWindow(index, commits, colors, 0, commits.length)).toEqual(
        whole,
      );
    }
  });

  test("keeps one checkpoint per stride rather than one per row", () => {
    const commits = history(CHECKPOINT_STRIDE * 4);
    const index = emptyGraphIndex();
    extendGraphIndex(index, commits, colors);
    expect(index.checkpoints).toHaveLength(5);
  });

  test("reports the widest row across the whole history", () => {
    const commits = history(CHECKPOINT_STRIDE * 2);
    const whole = layoutGraph(commits, colors);
    const widest = whole.reduce(
      (n, row) => Math.max(n, row.cellCount, row.connectorCount),
      1,
    );
    const index = emptyGraphIndex();
    extendGraphIndex(index, commits, colors);
    expect(index.columns).toBe(widest);
  });

  test("marks the head row wherever it falls", () => {
    const commits = history(CHECKPOINT_STRIDE + 10);
    const index = emptyGraphIndex();
    extendGraphIndex(index, commits, colors, "c505");
    // Past the first checkpoint, so the flag survives a replay rather than
    // only being set on the pass that laid the row out.
    const rows = graphWindow(index, commits, colors, 500, 10);
    expect(rows[5]!.commit.sha).toBe("c505");
    expect(rows[5]!.head).toBe(true);
    expect(rows[4]!.head).toBe(false);
  });

  test("serves a repeated window without replaying it", () => {
    const commits = history(CHECKPOINT_STRIDE + 10);
    const index = emptyGraphIndex();
    extendGraphIndex(index, commits, colors);
    const first = graphWindow(index, commits, colors, 400, 60);
    expect(graphWindow(index, commits, colors, 400, 60)).toBe(first);
    // A page invalidates it, since the fold past the old end has moved.
    extendGraphIndex(index, commits, colors);
    expect(index.window).toBeUndefined();
  });

  test("asks for nothing outside the laid-out range", () => {
    const commits = history(50);
    const index = emptyGraphIndex();
    extendGraphIndex(index, commits, colors);
    expect(graphWindow(index, commits, colors, 50, 10)).toEqual([]);
    expect(graphWindow(index, commits, colors, -1, 10)).toEqual([]);
    expect(graphWindow(index, commits, colors, 0, 0)).toEqual([]);
    // A window running off the end stops at the last row.
    expect(graphWindow(index, commits, colors, 45, 60)).toHaveLength(5);
  });
});
