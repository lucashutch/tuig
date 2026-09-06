import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { DiffView } from "../../src/ui/diff-view.js";
import { createDiffSyntaxStyle } from "../../src/ui/diff-syntax.js";
import {
  canHighlightDiff,
  DIFF_HIGHLIGHT_MAX_BYTES,
  DIFF_HIGHLIGHT_MAX_LINES,
} from "../../src/ui/diff-policy.js";

test("highlight bounds count UTF-8 bytes and short lines", () => {
  expect(canHighlightDiff("x".repeat(DIFF_HIGHLIGHT_MAX_BYTES - 1))).toBe(true);
  expect(canHighlightDiff("x".repeat(DIFF_HIGHLIGHT_MAX_BYTES))).toBe(false);
  expect(canHighlightDiff("é".repeat(DIFF_HIGHLIGHT_MAX_BYTES / 2))).toBe(
    false,
  );
  expect(canHighlightDiff("\n".repeat(DIFF_HIGHLIGHT_MAX_LINES - 1))).toBe(
    false,
  );
  expect(canHighlightDiff("\n".repeat(DIFF_HIGHLIGHT_MAX_LINES - 2))).toBe(
    true,
  );
});

test("clearing or replacing a diff destroys its document and native children", async () => {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 80,
    height: 20,
  });
  const syntaxStyle = createDiffSyntaxStyle();
  const view = new DiffView(renderer, {
    id: "test-diff",
    width: 80,
    height: 20,
    syntaxStyle,
  });
  renderer.root.add(view);
  const patch = "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new\n";
  try {
    view.setDiff(patch, undefined, "none");
    const old = view.getChildren()[0]!;
    await renderOnce();
    expect(captureCharFrame()).toContain("new");
    view.setDiff(patch.replace("+new", "+replacement"), undefined, "none");
    expect(old.isDestroyed).toBe(true);
    expect(view.getChildren()).toHaveLength(1);
    const current = view.getChildren()[0]!;
    view.clear();
    expect(current.isDestroyed).toBe(true);
    expect(view.getChildren()).toHaveLength(0);
    expect(view.diff).toBe("");
    await renderOnce();
    expect(captureCharFrame()).not.toContain("replacement");
  } finally {
    renderer.destroy();
    syntaxStyle.destroy();
  }
});

test("diff wrapper preserves wheel scrolling and resize-driven painting", async () => {
  const { renderer, renderOnce, mockMouse, resize, captureCharFrame } =
    await createTestRenderer({ width: 80, height: 12 });
  const syntaxStyle = createDiffSyntaxStyle();
  const view = new DiffView(renderer, {
    id: "scroll-diff",
    width: "100%",
    height: "100%",
    syntaxStyle,
  });
  renderer.root.add(view);
  const lines = Array.from(
    { length: 100 },
    (_, index) => `+line-${String(index).padStart(3, "0")}`,
  ).join("\n");
  try {
    view.setDiff(
      `--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1,100 @@\n${lines}\n`,
      undefined,
      "none",
    );
    await renderOnce();
    const before = captureCharFrame();
    expect(before).toContain("line-000");
    for (let i = 0; i < 5; i++) await mockMouse.scroll(20, 5, "down");
    await renderOnce();
    expect(captureCharFrame()).not.toBe(before);
    resize(60, 16);
    await renderOnce();
    expect(view.width).toBe(60);
    expect(captureCharFrame()).toContain("line-");
  } finally {
    renderer.destroy();
    syntaxStyle.destroy();
  }
});
