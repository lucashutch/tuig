import { expect, test } from "bun:test";
import {
  historyColumnLayout,
  historyDividerAt,
  isDividerDoubleClick,
} from "../../src/ui/history-columns.js";

test("header divider hit testing follows resized columns", () => {
  const layout = historyColumnLayout(120, 5, {
    branchWidth: 32,
    committerWidth: 16,
    showCommitter: true,
    showSha: true,
  });
  expect(historyDividerAt(32, layout)).toBe("branchWidth");
  expect(historyDividerAt(layout.messageStart - 2, layout)).toBe("graphWidth");
  expect(historyDividerAt(layout.messageEnd + 1, layout)).toBe(
    "committerWidth",
  );
  expect(historyDividerAt(layout.messageStart + 3, layout)).toBeUndefined();
});

test("the committer separator only resizes while the committer column is shown", () => {
  const layout = historyColumnLayout(120, 5, {
    showCommitter: false,
    showSha: true,
  });
  expect(historyDividerAt(layout.messageEnd + 1, layout)).toBeUndefined();
});

test("no column preference can leave empty space beside the SHA column", () => {
  for (const showCommitter of [true, false])
    for (const showSha of [true, false])
      for (const committerWidth of [1, 11, 40, 500])
        for (const graphWidth of [1, 20, 500]) {
          const layout = historyColumnLayout(100, 6, {
            branchWidth: 30,
            graphWidth,
            committerWidth,
            showCommitter,
            showSha,
          });
          const end =
            layout.messageEnd +
            (showCommitter ? layout.committerWidth + 3 : 0) +
            (showSha ? 11 : 0);
          // Only the scrollbar column remains.
          expect(end + 1).toBe(100);
        }
});

test("a second press on the same separator within the window is a double click", () => {
  const first = { key: "graphWidth" as const, at: 1000 };
  expect(isDividerDoubleClick(first, "graphWidth", 1300, 400)).toBe(true);
  expect(isDividerDoubleClick(first, "graphWidth", 1400, 400)).toBe(false);
  expect(isDividerDoubleClick(first, "branchWidth", 1100, 400)).toBe(false);
  expect(isDividerDoubleClick(undefined, "graphWidth", 1100, 400)).toBe(false);
});

test("oversized preferences are clamped after terminal resize", () => {
  const prefs = {
    branchWidth: 100,
    committerWidth: 200,
    showCommitter: true,
    showSha: true,
  };
  const layout = historyColumnLayout(80, 1, prefs);
  expect(layout.branchWidth).toBeLessThan(100);
  expect(layout.committerWidth).toBeLessThan(200);
  expect(layout.shaStart + 8 + 1).toBe(80);
});
