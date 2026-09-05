import type { CliRenderer, InputRenderable } from "@opentui/core";
import type { ChangedFile, RepositorySnapshot } from "../git/types.js";
import { shortSha } from "./history.js";
import {
  fitColumns,
  layoutChangeSections,
  workingChangesBannerRows,
  wrappedLineCount,
} from "./runtime-presentation.js";
import {
  PANE_TOP,
  createRuntimeWidgets,
  type ChangeSection,
} from "./runtime-widgets.js";

type RuntimeWidgets = ReturnType<typeof createRuntimeWidgets>;

type LayoutWidgets = Pick<
  RuntimeWidgets,
  | "sidebar"
  | "history"
  | "details"
  | "leftDivider"
  | "rightDivider"
  | "leftDividerBar"
  | "rightDividerBar"
  | "historyText"
  | "commitHeader"
  | "commitBody"
  | "commitBodyBox"
  | "editMessageButton"
  | "commitInfo"
  | "commitInfoBox"
  | "authorPhoto"
  | "authorBadge"
  | "commitCoAuthors"
  | "commitCoAuthorProvider"
  | "commitInfoLabel"
  | "commitDiff"
  | "commitDiffEmpty"
  | "discardButton"
  | "stageAllButton"
  | "unstageAllButton"
  | "unstagedLabel"
  | "unstagedText"
  | "stagedLabel"
  | "stagedText"
  | "unstagedDivider"
  | "composerDivider"
  | "unstagedDividerBar"
  | "composerDividerBar"
  | "composerBox"
  | "composerSummary"
  | "composerBody"
  | "commitButton"
  | "amendButton"
  | "workingBanner"
>;

export interface RuntimeLayoutContext extends LayoutWidgets {
  renderer: CliRenderer;
  branchFilterInput: InputRenderable;
  contentHeight: number;
  leftCollapsed: boolean;
  detailsCollapsed: boolean;
  leftWidth: number;
  detailsWidth: number;
  branchFilterActive: boolean;
  view: "history" | "commit" | "working";
  editingCommitSha?: string;
  snapshot?: RepositorySnapshot;
  commitIndex: number;
  commitHeaderValue: string;
  commitBodyValue: string;
  commitInfoValue: string;
  commitCoAuthorsValue: string;
  commitCoAuthorsProviderVisible: boolean;
  commitFilesTop: number;
  sidebarPaneWidth: number;
  detailsPaneWidth: number;
  historyContentLeft: number;
  historyContentWidth: number;
  sectionCollapsed: Record<ChangeSection, boolean>;
  preferredUnstagedHeight?: number;
  preferredComposerHeight?: number;
  files(section: ChangeSection): ChangedFile[];
  sectionRows(section: ChangeSection): unknown[];
  sectionViewport(section: ChangeSection): number;
  paintHeader(): void;
  paintToolbar(): void;
  paintHints(): void;
  positionMessage(): void;
  paint(): void;
}

export function layoutRuntime(context: RuntimeLayoutContext) {
  const total = Math.max(1, context.renderer.terminalWidth);
  // The header and toolbar own the top rows, so the panes start below them.
  const height = context.contentHeight;
  const available = Math.max(3, total - 2);
  const leftMin = context.leftCollapsed ? 1 : Math.min(12, available);
  const rightMin = context.detailsCollapsed ? 1 : Math.min(20, available);
  const centerMin = Math.max(1, Math.min(18, available - leftMin - rightMin));
  const left = context.leftCollapsed
    ? 1
    : Math.min(
        context.leftWidth,
        Math.max(leftMin, available - rightMin - centerMin),
      );
  const right = context.detailsCollapsed
    ? 1
    : Math.min(context.detailsWidth, Math.max(1, available - left - centerMin));
  const center = Math.max(1, available - left - right);
  context.sidebarPaneWidth = Math.min(left, total);
  context.sidebar.width = context.sidebarPaneWidth;
  context.sidebar.height = height;
  context.branchFilterInput.left = 1;
  context.branchFilterInput.top = PANE_TOP;
  context.branchFilterInput.width = Math.max(8, context.sidebarPaneWidth - 2);
  context.branchFilterInput.visible =
    context.branchFilterActive && !context.leftCollapsed;
  context.history.height = height;
  context.details.height = height;
  // Dividers stop above the bottom row so they cannot draw over the hints.
  const dividerHeight = Math.max(1, height - 1);
  context.leftDivider.height = dividerHeight;
  context.rightDivider.height = dividerHeight;
  context.leftDividerBar.height = dividerHeight;
  context.rightDividerBar.height = dividerHeight;
  context.sidebar.visible = !context.leftCollapsed && total > 1;
  // A collapsed pane keeps only its divider column, so the graph starts
  // immediately beside whichever divider is showing.
  const leftBoundary = context.leftCollapsed ? 0 : left;
  const rightBoundary = context.detailsCollapsed
    ? Math.max(leftBoundary + 2, total - 1)
    : left + center + 1;
  context.leftDivider.left = Math.max(0, Math.min(total - 1, leftBoundary - 1));
  context.leftDividerBar.left = Math.max(0, Math.min(total - 1, leftBoundary));
  // Positions and sizes are computed as plain numbers, because reading them
  // back off a renderable returns the previous frame's value.
  const historyLeft = Math.min(total - 1, leftBoundary + 1);
  const historyWidth = Math.max(
    1,
    Math.min(rightBoundary - historyLeft, total - historyLeft),
  );
  context.history.left = historyLeft;
  context.history.width = historyWidth;
  context.historyContentLeft = historyLeft + 1;
  context.historyContentWidth = Math.max(1, historyWidth - 2);
  context.historyText.width = context.historyContentWidth;
  context.historyText.height = Math.max(1, height - 2);
  context.rightDivider.left = Math.max(
    0,
    Math.min(total - 1, rightBoundary - 1),
  );
  context.rightDividerBar.left = Math.max(
    0,
    Math.min(total - 1, rightBoundary),
  );
  const detailsLeft = Math.min(total, rightBoundary + 1);
  context.details.left = detailsLeft;
  context.detailsPaneWidth = Math.max(
    1,
    Math.min(right, Math.max(1, total - detailsLeft)),
  );
  context.details.width = context.detailsPaneWidth;
  context.details.visible =
    !context.detailsCollapsed && detailsLeft < total - 1;
  // Leave room for the box borders, text inset, scrollbar, and percentage
  // width rounding used by OpenTUI's nested renderables.
  const textWidth = Math.max(10, context.detailsPaneWidth - 8);
  const headerLines = wrappedLineCount(context.commitHeaderValue, textWidth);
  const bodyLines = wrappedLineCount(context.commitBodyValue, textWidth);
  const messageHeight = headerLines + Math.min(15, bodyLines) + 3;
  context.commitHeader.height = headerLines;
  context.commitHeader.top = 1;
  context.commitBody.height = bodyLines;
  context.commitBody.top = headerLines;
  const bannerRows =
    context.view === "commit" && !context.editingCommitSha
      ? workingChangesBannerRows(context.snapshot?.files.length ?? 0)
      : 0;
  // Inspection follows a predictable order: message first, metadata, then
  // files. The cards' explicit rows keep narrow wrapping collision-free.
  context.commitBodyBox.top = bannerRows;
  context.commitBodyBox.height = messageHeight;
  context.editMessageButton.left = Math.max(1, context.detailsPaneWidth - 18);
  const infoWidth = Math.max(10, context.detailsPaneWidth - 13);
  const infoLines = wrappedLineCount(context.commitInfoValue, infoWidth);
  const coAuthorsTop = Math.max(6, infoLines + 2);
  const coAuthorsLines = context.commitCoAuthorsValue
    ? wrappedLineCount(context.commitCoAuthorsValue, textWidth)
    : 0;
  const infoHeight = Math.max(
    6,
    // Keep a spare row below wrapped identities so the changed-file
    // section can never share a line with the final metadata row.
    infoLines + 2,
    context.commitCoAuthorsValue ? coAuthorsTop + coAuthorsLines + 1 : 0,
  );
  // The metadata text sits below the COMMIT label inside the card.  Its
  // widget has a one-row default height, which silently clipped the author,
  // committer, and timestamp lines even though the surrounding box was
  // resized to fit them.
  context.commitInfo.height = Math.max(1, infoHeight - 1);
  context.commitInfo.left = 11;
  context.commitInfo.top = 0;
  context.commitInfo.width = Math.max(10, context.detailsPaneWidth - 13);
  context.authorPhoto.left = 1;
  context.authorPhoto.top = 1;
  context.authorPhoto.width = 8;
  context.authorPhoto.height = 4;
  context.authorBadge.left = 1;
  context.authorBadge.top = 2;
  context.authorBadge.width = 8;
  context.commitCoAuthorProvider.left = 1;
  context.commitCoAuthorProvider.top = coAuthorsTop;
  context.commitCoAuthorProvider.width = 4;
  context.commitCoAuthorProvider.height = 2;
  context.commitCoAuthors.left = context.commitCoAuthorsProviderVisible ? 7 : 1;
  context.commitCoAuthors.top = coAuthorsTop;
  context.commitCoAuthors.width = Math.max(
    10,
    context.detailsPaneWidth - context.commitCoAuthors.left - 2,
  );
  const sha = shortSha(
    context.snapshot?.commits[context.commitIndex]?.sha ?? "",
  );
  const labelWidth = Math.max(1, context.detailsPaneWidth - 2);
  context.commitInfoLabel.width = labelWidth;
  const label = "DETAILS";
  const gap = sha
    ? Math.max(2, labelWidth - Bun.stringWidth(label) - Bun.stringWidth(sha))
    : 1;
  context.commitInfoLabel.content = fitColumns(
    `${label}${" ".repeat(gap)}${sha}`,
    labelWidth,
  );
  // Leave a visible strip between the raised message card and DETAILS.
  context.commitInfoBox.top = bannerRows + messageHeight + 1;
  context.commitInfoBox.height = infoHeight;
  // Do not clamp this back into the metadata card in short terminals. The
  // file viewport may be small/off-screen, but its header must never paint
  // over wrapped author or committer rows.
  context.commitFilesTop = Number(context.commitInfoBox.top) + infoHeight + 1;
  layoutChanges(context, height);
  // A selected file diff is a temporary overlay over the history pane. Keep
  // commit metadata in the RHS details pane, but let the diff use the graph's
  // full width like desktop Git clients do.
  context.commitDiff.left = historyLeft + 1;
  context.commitDiff.top = PANE_TOP + 1;
  context.commitDiff.width = Math.max(1, historyWidth - 2);
  context.commitDiff.height = Math.max(1, height - 2);
  context.commitDiffEmpty.left = historyLeft + 3;
  context.commitDiffEmpty.top = PANE_TOP + 4;
  context.commitDiffEmpty.width = Math.max(1, historyWidth - 6);
  const verticalGripHeight = Math.max(
    3,
    Math.min(9, Math.floor(dividerHeight / 3)),
  );
  const verticalGripStart = Math.max(
    0,
    Math.floor((dividerHeight - verticalGripHeight) / 2),
  );
  const dividerContent = Array.from({ length: dividerHeight }, (_, row) =>
    row >= verticalGripStart && row < verticalGripStart + verticalGripHeight
      ? "║"
      : "│",
  ).join("\n");
  context.leftDividerBar.content = dividerContent;
  context.rightDividerBar.content = dividerContent;
  context.paintHeader();
  context.paintToolbar();
  context.paintHints();
  context.positionMessage();
  if (context.snapshot) {
    context.paint();
  }
}
/**
 * Place the changes pane: pane actions, the two file sections, and the
 * commit composer, or the commit-file list when a commit is open.
 */
export function layoutChanges(context: RuntimeLayoutContext, height: number) {
  const commitView = context.view === "commit";
  const editing = !!context.editingCommitSha;
  const width = Math.max(1, context.detailsPaneWidth);
  // Diffs overlay the history pane. Keep the working changes layout intact;
  // commit diffs retain their file picker without the working-tree controls.
  if (context.commitDiff.visible && commitView) {
    for (const widget of [
      context.discardButton,
      context.stageAllButton,
      context.unstageAllButton,
      context.stagedLabel,
      context.stagedText,
      context.unstagedDivider,
      context.composerDivider,
      context.unstagedDividerBar,
      context.composerDividerBar,
      context.composerBox,
    ])
      widget.visible = false;
    context.unstagedLabel.visible = true;
    context.unstagedText.visible = true;
    context.amendButton.visible = false;
    return;
  }
  for (const widget of [
    context.discardButton,
    context.stageAllButton,
    context.unstageAllButton,
    context.composerBox,
    context.stagedLabel,
    context.stagedText,
  ])
    widget.visible = !commitView || (widget === context.composerBox && editing);
  context.amendButton.visible = !commitView;
  context.workingBanner.visible =
    commitView && !editing && (context.snapshot?.files.length ?? 0) > 0;
  context.workingBanner.height = workingChangesBannerRows(
    context.snapshot?.files.length ?? 0,
  );
  context.editMessageButton.visible = commitView && !editing;
  for (const widget of [
    context.unstagedDivider,
    context.composerDivider,
    context.unstagedDividerBar,
    context.composerDividerBar,
  ])
    widget.visible = !commitView && !editing;
  if (commitView && !editing) {
    // These widgets are also used for the commit file picker. Restore them
    // explicitly because a preceding working-tree diff hides them.
    context.unstagedLabel.visible = true;
    context.unstagedText.visible = true;
    context.unstagedLabel.top = context.commitFilesTop;
    context.unstagedText.top = context.commitFilesTop + 1;
    context.unstagedText.height = context.sectionViewport("unstaged");
    return;
  }
  if (editing) {
    context.composerBox.top = 1;
    const composerHeight = Math.max(0, height - 2);
    context.composerBox.height = composerHeight;
    context.composerBox.visible = composerHeight > 0 && width >= 2;
    const boxWidth = Math.max(1, width - 2);
    const fieldWidth = Math.max(1, boxWidth - 1);
    context.composerBox.width = boxWidth;
    context.composerSummary.width = fieldWidth;
    context.composerBody.width = fieldWidth;
    context.commitButton.width = fieldWidth;
    layoutComposerChildren(context, composerHeight, boxWidth);
    return;
  }
  context.discardButton.top = 0;
  context.discardButton.left = 1;
  context.stageAllButton.top = 0;
  context.stageAllButton.left = Math.max(
    Number(context.discardButton.width) + 2,
    width - Number(context.stageAllButton.width) - 2,
  );
  const layout = layoutChangeSections({
    // The bottom row belongs to the hints, so the pane stops one row short.
    available: Math.max(0, height - 1),
    unstagedRows: context.sectionRows("unstaged").length,
    stagedRows: context.sectionRows("staged").length,
    unstagedCollapsed: context.sectionCollapsed.unstaged,
    stagedCollapsed: context.sectionCollapsed.staged,
    preferredUnstagedHeight: context.preferredUnstagedHeight,
    preferredComposerHeight: context.preferredComposerHeight,
  });
  context.unstagedLabel.top = layout.unstagedTop;
  context.unstagedText.top = layout.unstagedTop + 1;
  context.unstagedText.height = Math.max(1, layout.unstagedHeight);
  context.unstagedText.visible = layout.unstagedHeight > 0;
  context.stagedLabel.top = layout.stagedTop;
  context.unstageAllButton.top = layout.stagedTop;
  context.unstageAllButton.left = Math.max(
    1,
    width - Number(context.unstageAllButton.width) - 2,
  );
  context.unstageAllButton.visible =
    !context.sectionCollapsed.staged && context.files("staged").length > 0;
  context.stagedText.top = layout.stagedTop + 1;
  context.stagedText.height = Math.max(1, layout.stagedHeight);
  context.stagedText.visible = layout.stagedHeight > 0;
  context.composerBox.top = layout.composerTop;
  context.composerBox.height = layout.composerHeight;
  context.composerBox.visible = layout.composerHeight > 0 && width >= 2;
  // Percentage widths round unpredictably inside nested renderables, so the
  // composer's children are sized from the pane width directly.
  const boxWidth = Math.max(1, width - 2);
  context.composerBox.width = boxWidth;
  const fieldWidth = Math.max(1, boxWidth - 1);
  context.composerSummary.width = fieldWidth;
  context.composerBody.width = fieldWidth;
  context.commitButton.width = fieldWidth;
  layoutComposerChildren(context, layout.composerHeight, boxWidth);
  const gripWidth = Math.max(3, Math.min(9, Math.floor(width / 3)));
  const gripStart = Math.max(0, Math.floor((width - gripWidth) / 2));
  const divider = `${"─".repeat(gripStart)}${"═".repeat(gripWidth)}${"─".repeat(Math.max(0, width - gripStart - gripWidth))}`;
  context.unstagedDivider.top = Math.max(0, layout.unstagedDividerTop - 1);
  context.unstagedDivider.left = Math.floor(width / 4);
  context.unstagedDivider.width = Math.min(
    width,
    Math.max(5, Math.floor(width / 2)),
  );
  context.unstagedDivider.visible = true;
  context.unstagedDividerBar.top = context.unstagedDivider.top;
  context.unstagedDividerBar.width = width;
  context.unstagedDividerBar.content = divider;
  context.unstagedDividerBar.visible = context.unstagedDivider.visible;
  context.composerDivider.top = Math.max(0, layout.composerDividerTop - 1);
  context.composerDivider.left = Math.floor(width / 4);
  context.composerDivider.width = Math.min(
    width,
    Math.max(5, Math.floor(width / 2)),
  );
  context.composerDivider.visible = true;
  context.composerDividerBar.top = context.composerDivider.top;
  context.composerDividerBar.width = width;
  context.composerDividerBar.content = divider;
  context.composerDividerBar.visible = true;
}
export function layoutComposerChildren(
  context: RuntimeLayoutContext,
  height: number,
  width: number,
) {
  context.composerBody.top = 2;
  const hasFieldRoom = width >= 2;
  context.composerSummary.visible = hasFieldRoom && height >= 2;
  context.composerBody.visible = hasFieldRoom && height >= 3;
  context.composerBody.height = Math.max(1, height - 6);
  const showActions = hasFieldRoom && height >= 6;
  context.amendButton.visible = showActions && !context.editingCommitSha;
  context.commitButton.visible = showActions;
  context.amendButton.top = height - 3;
  context.commitButton.top = height - 2;
}
