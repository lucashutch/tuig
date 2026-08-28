import { expect, test } from "bun:test";
import type { RuntimeLayoutContext } from "../../src/ui/runtime-layout.js";
import { layoutChanges } from "../../src/ui/runtime-layout.js";

const widget = (visible = false) => ({
  visible,
  top: 0,
  height: 1,
  width: 1,
});

function layoutContext(
  view: RuntimeLayoutContext["view"],
  diffVisible: boolean,
): RuntimeLayoutContext {
  return {
    view,
    editingCommitSha: undefined,
    detailsPaneWidth: 40,
    commitDiff: widget(diffVisible),
    unstagedLabel: widget(),
    unstagedText: widget(),
    stagedLabel: widget(true),
    stagedText: widget(true),
    discardButton: widget(true),
    stageAllButton: widget(true),
    unstageAllButton: widget(true),
    unstagedDivider: widget(true),
    composerDivider: widget(true),
    unstagedDividerBar: widget(true),
    composerDividerBar: widget(true),
    composerBox: widget(true),
    amendButton: widget(true),
    workingBanner: widget(true),
    editMessageButton: widget(true),
    commitFilesTop: 4,
    sectionViewport: () => 10,
  } as unknown as RuntimeLayoutContext;
}

test("commit diffs keep the commit file tree visible", () => {
  const context = layoutContext("commit", true);

  layoutChanges(context, 24);

  expect(context.unstagedLabel.visible).toBe(true);
  expect(context.unstagedText.visible).toBe(true);
  expect(context.stagedText.visible).toBe(false);
});

test("working-tree diffs hide their file tree, then restore the commit tree", () => {
  const context = layoutContext("working", true);

  layoutChanges(context, 24);
  expect(context.unstagedLabel.visible).toBe(false);
  expect(context.unstagedText.visible).toBe(false);

  context.view = "commit";
  context.commitDiff.visible = false;
  layoutChanges(context, 24);

  expect(context.unstagedLabel.visible).toBe(true);
  expect(context.unstagedText.visible).toBe(true);
});
