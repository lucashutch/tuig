import { describe, expect, test } from "bun:test";
import {
  changedDiffRowsInRange,
  diffLineTarget,
  renderedDiffLineTarget,
} from "../../src/ui/diff-lines.js";

describe("diff line targets", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,3 +10,4 @@",
    " same",
    "-old",
    "+new",
    "+extra",
    " tail",
  ].join("\n");

  test("maps context and changed rows to their file side", () => {
    expect(diffLineTarget(diff, 4)).toEqual({
      line: 10,
      side: "new",
      kind: "context",
      oldLine: 10,
      rawRow: 4,
      renderedRow: 0,
    });
    expect(diffLineTarget(diff, 5)).toEqual({
      line: 11,
      side: "old",
      kind: "removed",
      oldLine: 11,
      rawRow: 5,
      renderedRow: 1,
    });
    expect(diffLineTarget(diff, 6)).toEqual({
      line: 11,
      side: "new",
      kind: "added",
      rawRow: 6,
      renderedRow: 2,
    });
    expect(diffLineTarget(diff, 7)).toEqual({
      line: 12,
      side: "new",
      kind: "added",
      rawRow: 7,
      renderedRow: 3,
    });
    expect(diffLineTarget(diff, 8)).toEqual({
      line: 13,
      side: "new",
      kind: "context",
      oldLine: 12,
      rawRow: 8,
      renderedRow: 4,
    });
  });

  test("does not treat headers as source lines", () => {
    expect(diffLineTarget(diff, 2)).toBeUndefined();
    expect(diffLineTarget(diff, 3)).toBeUndefined();
  });

  test("maps displayed hunk rows without counting patch headers", () => {
    expect(renderedDiffLineTarget(diff, 2, [0])).toEqual({
      line: 11,
      side: "new",
      kind: "added",
      rawRow: 6,
      renderedRow: 2,
    });
  });

  test("does not count no-newline markers as displayed rows", () => {
    const marker = diff.replace(
      "+extra",
      "+extra\n\\ No newline at end of file",
    );
    expect(renderedDiffLineTarget(marker, 4, [0])).toEqual({
      line: 13,
      side: "new",
      kind: "context",
      oldLine: 12,
      rawRow: 9,
      renderedRow: 4,
    });
  });

  test("collects only changed rows across a drag range in either direction", () => {
    expect(changedDiffRowsInRange(diff, 4, 8)).toEqual([5, 6, 7]);
    expect(changedDiffRowsInRange(diff, 8, 4)).toEqual([5, 6, 7]);
  });
});
