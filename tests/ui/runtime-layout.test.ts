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
    unstagedLabel: widget(true),
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
    composerSummary: widget(),
    composerBody: widget(),
    commitButton: widget(),
    amendButton: widget(true),
    workingBanner: widget(true),
    editMessageButton: widget(true),
    commitFilesTop: 4,
    sectionViewport: () => 10,
    sectionRows: () => [{}, {}],
    sectionCollapsed: { staged: false, unstaged: false },
    files: () => [{}],
  } as unknown as RuntimeLayoutContext;
}

test("commit diffs keep the commit file tree visible", () => {
  const context = layoutContext("commit", true);

  layoutChanges(context, 24);

  expect(context.unstagedLabel.visible).toBe(true);
  expect(context.unstagedText.visible).toBe(true);
  expect(context.stagedText.visible).toBe(false);
});

test("working-tree diffs retain both file sections and the composer", () => {
  const context = layoutContext("working", true);

  layoutChanges(context, 24);
  expect(context.unstagedLabel.visible).toBe(true);
  expect(context.unstagedText.visible).toBe(true);
  expect(context.stagedLabel.visible).toBe(true);
  expect(context.stagedText.visible).toBe(true);
  expect(context.composerBox.visible).toBe(true);
  expect(context.workingBanner.visible).toBe(false);
  expect(context.editMessageButton.visible).toBe(false);

  context.view = "commit";
  context.commitDiff.visible = false;
  layoutChanges(context, 24);

  expect(context.unstagedLabel.visible).toBe(true);
  expect(context.unstagedText.visible).toBe(true);
});
