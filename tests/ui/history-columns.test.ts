import { expect, test } from "bun:test";
import {
  historyColumnLayout,
  historyDividerAt,
} from "../../src/ui/history-columns.js";

test("header divider hit testing follows resized columns", () => {
  const layout = historyColumnLayout(120, 5, {
    branchWidth: 32,
    messageWidth: 20,
    showCommitter: true,
    showSha: true,
  });
  expect(historyDividerAt(32, layout)).toBe("branchWidth");
  expect(historyDividerAt(layout.messageStart - 2, layout)).toBe("graphWidth");
  expect(historyDividerAt(layout.messageEnd + 1, layout)).toBe("messageWidth");
  expect(historyDividerAt(layout.messageStart + 3, layout)).toBeUndefined();
});

test("oversized preferences are clamped after terminal resize", () => {
  const prefs = {
    branchWidth: 100,
    messageWidth: 200,
    showCommitter: true,
    showSha: true,
  };
  const layout = historyColumnLayout(80, 1, prefs);
  expect(layout.branchWidth).toBeLessThan(100);
  expect(layout.messageWidth).toBeLessThan(200);
  expect(layout.shaStart + 8 + layout.padding + 1).toBe(80);
});
