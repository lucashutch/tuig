import { describe, expect, test } from "bun:test";
import {
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
    });
    expect(diffLineTarget(diff, 5)).toEqual({
      line: 11,
      side: "old",
      kind: "removed",
      oldLine: 11,
    });
    expect(diffLineTarget(diff, 6)).toEqual({
      line: 11,
      side: "new",
      kind: "added",
    });
    expect(diffLineTarget(diff, 7)).toEqual({
      line: 12,
      side: "new",
      kind: "added",
    });
    expect(diffLineTarget(diff, 8)).toEqual({
      line: 13,
      side: "new",
      kind: "context",
      oldLine: 12,
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
    });
  });
});
