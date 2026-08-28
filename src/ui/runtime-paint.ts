import {
  StyledText,
  bg,
  fg,
  type InputRenderable,
  type TextRenderable,
} from "@opentui/core";
import type {
  BranchRef,
  ChangedFile,
  RepositorySnapshot,
} from "../git/types.js";
import { buildFileTree, fitTreeLabel, flattenVisible } from "./file-tree.js";
import type { GraphRow } from "./graph.js";
import {
  filterBranchRefs,
  primaryDecorationRef,
  shortSha,
  summariseDecorations,
} from "./history.js";
import { resolveMaterialIcon } from "./icon-theme.js";
import type { GraphAvatarRequest } from "./runtime-data.js";
import {
  SIDEBAR_SECTIONS,
  fileColor,
  fitColumns,
  layoutSidebarSections,
  renderSidebarViewport,
  renderSubmoduleSidebarViewport,
  sidebarHeader,
  sidebarRows,
  type SidebarSection,
} from "./runtime-presentation.js";
import { oneDarkTheme } from "./theme.js";
import { createRuntimeWidgets, type ChangeSection } from "./runtime-widgets.js";

type SidebarWidgets = ReturnType<
  typeof createRuntimeWidgets
>["sidebarSections"];

export interface RuntimePaintContext {
  snapshot?: RepositorySnapshot;
  contentHeight: number;
  sidebarPreferred: Record<SidebarSection, number | undefined>;
  sidebarCollapsed: Record<SidebarSection, boolean>;
  sidebarStart: Record<SidebarSection, number>;
  sidebarSections: SidebarWidgets;
  sidebarPaneWidth: number;
  branchFilter: string;
  paintHeader(): void;
  paintToolbar(): void;
  layoutChanges(height: number): void;
  view: "history" | "commit" | "working";
  mode: ChangeSection;
  focus: "history" | "changes";
  sectionCollapsed: Record<ChangeSection, boolean>;
  sectionStart: Record<ChangeSection, number>;
  fileStart: number;
  setFileStart(value: number): void;
  files(section?: ChangeSection): ChangedFile[];
  label(section: ChangeSection): TextRenderable;
  list(section: ChangeSection): TextRenderable;
  sectionViewport(section: ChangeSection): number;
  selectedFile(): ChangedFile | undefined;
  expandedFiles: Set<string>;
  detailsPaneWidth: number;
  graphRows: GraphRow[];
  graphColumns: number;
  branchHints: Map<string, string>;
  historySelection: "working" | "commit";
  commitIndex: number;
  historyStart: number;
  setHistoryStart(value: number): void;
  historyViewportDetached: boolean;
  historyContentWidth: number;
  historyShaHits: Map<number, { start: number; end: number }>;
  historyLabelHits: Map<
    number,
    { start: number; end: number; ref?: BranchRef }
  >;
  historyText: TextRenderable;
  /** True while a diff overlay covers the history pane. */
  commitDiffVisible: boolean;
  updateGraphAvatars(requests: readonly GraphAvatarRequest[]): void;
  editingCommitSha?: string;
  composerSummary: InputRenderable;
  commitButton: TextRenderable;
  amendButton: TextRenderable;
  amend: boolean;
}

export function paint(ctx: RuntimePaintContext) {
  const s = ctx.snapshot;
  if (!s) return;
  const rects = layoutSidebarSections(
    ctx.contentHeight,
    ctx.sidebarPreferred,
    ctx.sidebarCollapsed,
  );
  for (const section of SIDEBAR_SECTIONS) {
    const rect = rects[section],
      widgets = ctx.sidebarSections[section];
    const rows = sidebarRows(
      s,
      section,
      ctx.sidebarPaneWidth,
      ctx.branchFilter,
    );
    const start = Math.max(
      0,
      Math.min(
        Math.max(0, rows.length - rect.contentHeight),
        ctx.sidebarStart[section],
      ),
    );
    ctx.sidebarStart[section] = start;
    widgets.box.top = rect.headerTop;
    widgets.box.height = Math.max(1, 1 + rect.contentHeight);
    widgets.box.width = ctx.sidebarPaneWidth;
    widgets.box.visible = rect.headerTop < ctx.contentHeight;
    const count =
      section === "local"
        ? filterBranchRefs(
            s.branches.filter((b) => !b.remote),
            ctx.branchFilter,
          ).length
        : section === "remote"
          ? filterBranchRefs(
              s.branches.filter((b) => b.remote),
              ctx.branchFilter,
            ).length
          : section === "submodules"
            ? s.submodules.length
            : section === "stashes"
              ? s.stashes.length
              : s.worktrees.length;
    widgets.header.content = sidebarHeader(
      section,
      count,
      ctx.sidebarCollapsed[section],
    );
    widgets.text.top = 1;
    widgets.text.height = Math.max(1, rect.contentHeight);
    widgets.text.visible =
      !ctx.sidebarCollapsed[section] && rect.contentHeight > 0;
    widgets.text.content =
      section === "submodules" && s.submodules.length > 0
        ? renderSubmoduleSidebarViewport(
            s.submodules,
            ctx.sidebarPaneWidth,
            start,
            rect.contentHeight,
          )
        : renderSidebarViewport(
            rows,
            ctx.sidebarPaneWidth,
            start,
            rect.contentHeight,
          ).join("\n");
    const showDivider = rect.dividerTop !== undefined;
    widgets.divider.top = Math.max(0, (rect.dividerTop ?? 0) - 1);
    widgets.divider.left = Math.floor(ctx.sidebarPaneWidth / 4);
    widgets.divider.width = Math.min(
      ctx.sidebarPaneWidth,
      Math.max(5, Math.floor(ctx.sidebarPaneWidth / 2)),
    );
    widgets.divider.visible = showDivider;
    widgets.dividerBar.top = rect.dividerTop ?? 0;
    widgets.dividerBar.width = ctx.sidebarPaneWidth;
    const width = Math.max(1, ctx.sidebarPaneWidth),
      grip = Math.max(3, Math.min(9, Math.floor(width / 3))),
      gripStart = Math.max(0, Math.floor((width - grip) / 2));
    widgets.dividerBar.content = `${"─".repeat(gripStart)}${"═".repeat(grip)}${"─".repeat(Math.max(0, width - gripStart - grip))}`;
    widgets.dividerBar.visible = showDivider;
  }
  ctx.paintHeader();
  ctx.paintToolbar();
  paintHistory(ctx);
  paintFiles(ctx);
}

/** Physical terminal lines per commit row; the extra line enlarges the dot. */
export const GRAPH_ROW_LINES = 2;

export function paintHistory(ctx: RuntimePaintContext) {
  const s = ctx.snapshot;
  if (!s) return;
  const hasWorking = s.files.length > 0,
    lines = Math.max(1, ctx.contentHeight - 3),
    total = ctx.graphRows.length + (hasWorking ? 1 : 0);
  const selectedDisplay =
    ctx.historySelection === "working" && hasWorking
      ? 0
      : ctx.commitIndex + (hasWorking ? 1 : 0);
  let start = ctx.historyStart;
  if (!ctx.historyViewportDetached) {
    if (selectedDisplay < start) start = selectedDisplay;
    else if (selectedDisplay >= start + visibleUnits(ctx, start))
      start = selectedDisplay - visibleUnits(ctx, start) + 1;
  }
  start = Math.max(
    0,
    Math.min(Math.max(0, total - visibleUnits(ctx, start)), start),
  );
  ctx.setHistoryStart(start);
  const visible = visibleUnits(ctx, start);
  const chunks = [
    fg(ctx.focus === "history" ? oneDarkTheme.accent : oneDarkTheme.muted)(
      ` BRANCH / TAG          GRAPH  ${s.commits.length} COMMITS\n`,
    ),
  ];
  ctx.historyShaHits.clear();
  ctx.historyLabelHits.clear();
  const labelWidth = Math.min(
      22,
      Math.max(14, Math.floor(ctx.historyContentWidth * 0.28)),
    ),
    backgrounds = [oneDarkTheme.bg, oneDarkTheme.panelRaised];
  const maxStart = Math.max(0, total - visible),
    thumbSize = Math.max(
      1,
      Math.floor((visible * visible) / Math.max(1, total)),
    ),
    thumbStart = maxStart
      ? Math.floor((start / maxStart) * Math.max(0, visible - thumbSize))
      : 0;
  const thumb = (o: number) => o >= thumbStart && o < thumbStart + thumbSize,
    scroll = (o: number) => (thumb(o) ? "█" : "│");
  const avatarRequests: GraphAvatarRequest[] = [];
  let line = 0;
  // While the working row is on screen it still takes a single line; past it
  // every commit owns GRAPH_ROW_LINES lines.
  if (hasWorking && start === 0 && line < lines) {
    const selected = ctx.historySelection === "working",
      rowBg = selected ? oneDarkTheme.selected : oneDarkTheme.panelRaised,
      working = selected ? "▸ ● Working changes" : "  ● Working changes",
      count = `  ${s.files.length} files`,
      countWidth = Math.max(
        Bun.stringWidth(count),
        ctx.historyContentWidth - Bun.stringWidth(working) - 1,
      );
    chunks.push(
      bg(rowBg)(fg(oneDarkTheme.warning)(working)),
      bg(rowBg)(fg(oneDarkTheme.muted)(count.padEnd(countWidth))),
      bg(rowBg)(
        fg(thumb(0) ? oneDarkTheme.accent : oneDarkTheme.border)(
          `${scroll(0)}\n`,
        ),
      ),
    );
    line++;
  }
  for (
    let unit = Math.max(start, hasWorking && start === 0 ? 1 : 0);
    unit < total && line < lines;
    unit++
  ) {
    const commitRow = unit - (hasWorking ? 1 : 0),
      row = ctx.graphRows[commitRow]!,
      offset = unit - start,
      selected =
        ctx.historySelection === "commit" && commitRow === ctx.commitIndex,
      summary = summariseDecorations(row.commit.decorations, s.branches);
    let primary = summary.label;
    if (selected && !primary)
      primary = ctx.branchHints.get(row.commit.sha) ?? "";
    const chip = summary.extra > 0 ? ` +${summary.extra}` : "",
      label = primary
        ? fitColumns(primary, labelWidth - 2 - chip.length, true).trimEnd() +
          chip
        : "",
      labelText = label
        ? fitColumns(` ${label} `, labelWidth)
        : "".padEnd(labelWidth),
      graphColor = row.cells[row.lane]?.color ?? oneDarkTheme.accent;
    const rowBg = selected
        ? oneDarkTheme.selected
        : backgrounds[commitRow % 2]!,
      stash = row.commit.decorations.some(
        (d) => d === "refs/stash" || d === "stash",
      ),
      textWidth = Math.max(
        2,
        ctx.historyContentWidth - (labelWidth + 2 + ctx.graphColumns * 2 + 15),
      ),
      authorWidth = Math.max(1, Math.min(11, textWidth - 8)),
      subjectWidth = Math.max(1, textWidth - authorWidth),
      subject = fitColumns(row.commit.subject, subjectWidth, true),
      padding = Math.max(0, ctx.graphColumns - row.cells.length),
      author = fitColumns(row.commit.author, authorWidth, true);
    chunks.push(
      bg(stash ? oneDarkTheme.panelRaised : rowBg)(
        fg(
          stash ? oneDarkTheme.muted : label ? graphColor : oneDarkTheme.muted,
        )(labelText),
      ),
      bg(rowBg)(fg(oneDarkTheme.muted)(selected ? "▸ " : "  ")),
      ...row.cells.map((c) => bg(rowBg)(fg(c.color)(c.symbol))),
      bg(rowBg)(fg(oneDarkTheme.muted)("  ".repeat(padding))),
      bg(rowBg)(
        fg(row.head ? oneDarkTheme.warning : oneDarkTheme.text)(subject),
      ),
      bg(rowBg)(fg(oneDarkTheme.border)(" │ ")),
      bg(rowBg)(fg(oneDarkTheme.author)(author)),
      bg(rowBg)(fg(oneDarkTheme.border)(" │ ")),
      bg(rowBg)(fg(oneDarkTheme.accent)(shortSha(row.commit.sha))),
      bg(rowBg)(
        fg(thumb(offset) ? oneDarkTheme.accent : oneDarkTheme.border)(
          `${scroll(offset)}\n`,
        ),
      ),
    );
    const dotLine = line;
    line++;
    // The second line keeps each lane's route running between dots, so the
    // enlarged avatar has room without breaking the graph apart.
    if (line < lines) {
      const graphWidth = labelWidth + 2 + ctx.graphColumns * 2,
        contentPad = Math.max(1, ctx.historyContentWidth - graphWidth - 1),
        connectorPadding = Math.max(
          0,
          ctx.graphColumns - row.connectors.length,
        );
      chunks.push(
        bg(rowBg)(fg(oneDarkTheme.muted)(" ".repeat(labelWidth + 2))),
        ...row.connectors.map((c) => bg(rowBg)(fg(c.color)(c.symbol))),
        bg(rowBg)(fg(oneDarkTheme.muted)("  ".repeat(connectorPadding))),
        bg(rowBg)(fg(oneDarkTheme.muted)(" ".repeat(contentPad))),
        bg(rowBg)(
          fg(thumb(offset) ? oneDarkTheme.accent : oneDarkTheme.border)(
            `${scroll(offset)}\n`,
          ),
        ),
      );
      line++;
    }
    avatarRequests.push({
      slot: avatarRequests.length,
      commit: row.commit,
      color: row.cells[row.lane]?.color ?? oneDarkTheme.accent,
      background: rowBg,
      // The dot sits in the left character of its two-column cell; a
      // three-column box starting one column left centers the lane line
      // behind the avatar the way desktop Git clients draw it.
      left: 1 + labelWidth + 2 + row.lane * 2 - 1,
      top: 2 + dotLine,
    });
    const shaStart =
      labelWidth +
      2 +
      ctx.graphColumns * 2 +
      subjectWidth +
      3 +
      authorWidth +
      3;
    ctx.historyShaHits.set(commitRow, { start: shaStart, end: shaStart + 8 });
    if (label)
      ctx.historyLabelHits.set(commitRow, {
        start: 0,
        end: labelWidth,
        ref: primaryDecorationRef(row.commit.decorations, s.branches),
      });
  }
  ctx.historyText.content = new StyledText(chunks);
  ctx.updateGraphAvatars(ctx.commitDiffVisible ? [] : avatarRequests);
}

/** Commit rows that fit in the history viewport from a given scroll offset. */
function visibleUnits(ctx: RuntimePaintContext, start: number): number {
  const lines = Math.max(1, ctx.contentHeight - 3);
  const reserved =
    ctx.snapshot && ctx.snapshot.files.length > 0 && start === 0 ? 1 : 0;
  return Math.max(1, Math.floor((lines - reserved) / GRAPH_ROW_LINES));
}

export function paintFiles(ctx: RuntimePaintContext) {
  ctx.layoutChanges(ctx.contentHeight);
  if (ctx.view === "commit") {
    paintSection(ctx, "unstaged");
    return;
  }
  paintSection(ctx, "unstaged");
  paintSection(ctx, "staged");
  paintComposer(ctx);
}
export function paintSection(ctx: RuntimePaintContext, section: ChangeSection) {
  const commit = ctx.view === "commit",
    files = ctx.files(commit ? ctx.mode : section),
    label = ctx.label(section),
    list = ctx.list(section),
    active = !commit && section === ctx.mode,
    collapsed = !commit && ctx.sectionCollapsed[section];
  label.content = new StyledText([
    fg(
      commit || (ctx.focus === "changes" && active)
        ? oneDarkTheme.accent
        : oneDarkTheme.muted,
    )(
      commit
        ? ` COMMIT FILES  ${files.length}`
        : ` ${collapsed ? "▶" : "▼"} ${section === "staged" ? "Staged" : "Unstaged"} files (${files.length})`,
    ),
  ]);
  if (collapsed) {
    list.content = "";
    return;
  }
  const limit = ctx.sectionViewport(section);
  if (commit) list.height = limit;
  const tree = buildFileTree(files);
  if (ctx.expandedFiles.size === 0)
    for (const node of tree.children)
      if (node.kind === "directory") ctx.expandedFiles.add(node.path);
  const all = flattenVisible(tree, ctx.expandedFiles),
    start = Math.max(
      0,
      Math.min(
        Math.max(0, all.length - limit),
        active || commit ? ctx.fileStart : ctx.sectionStart[section],
      ),
    );
  ctx.sectionStart[section] = start;
  if (active || commit) ctx.setFileStart(start);
  const rows = all.slice(start, start + limit);
  if (!rows.length) {
    list.content = commit
      ? new StyledText([
          fg(oneDarkTheme.muted)("  No changed files in this commit\n"),
          fg(oneDarkTheme.muted)("  esc  back to the graph"),
        ])
      : new StyledText([
          fg(oneDarkTheme.muted)(
            section === "staged" ? "  Nothing staged" : "  Nothing to stage",
          ),
        ]);
    return;
  }
  const selectedPath = active || commit ? ctx.selectedFile()?.path : undefined,
    chunks = [];
  for (const { node, depth } of rows) {
    const selected = node.kind === "file" && node.path === selectedPath,
      color = fileColor(node),
      icon = resolveMaterialIcon(
        node.name,
        node.kind === "directory",
        node.kind === "directory" && ctx.expandedFiles.has(node.path),
      ),
      nameColor =
        node.kind === "directory" ? oneDarkTheme.folder : oneDarkTheme.text,
      treeLabel = fitTreeLabel(
        node.name,
        Math.max(6, ctx.detailsPaneWidth - depth * 2 - 9),
      );
    chunks.push(
      selected ? bg(oneDarkTheme.selected)("▸ ") : fg(oneDarkTheme.muted)("  "),
      fg(oneDarkTheme.border)("│ ".repeat(depth)),
      node.kind === "directory"
        ? fg(oneDarkTheme.folder)(
            ctx.expandedFiles.has(node.path) ? "▼ " : "▶ ",
          )
        : fg(oneDarkTheme.muted)("  "),
      fg(color ?? icon.color ?? oneDarkTheme.folder)(`${icon.glyph} `),
      selected
        ? bg(oneDarkTheme.selected)(fg(nameColor)(treeLabel))
        : fg(nameColor)(treeLabel),
      fg(oneDarkTheme.muted)("\n"),
    );
  }
  list.content = new StyledText(chunks);
}
export function paintComposer(ctx: RuntimePaintContext) {
  if (ctx.editingCommitSha) {
    ctx.commitButton.fg = oneDarkTheme.added;
    ctx.commitButton.content = "Save message";
    return;
  }
  const staged = ctx.files("staged").length,
    ready = staged > 0 && ctx.composerSummary.value.trim().length > 0,
    width = Math.max(10, ctx.detailsPaneWidth - 4),
    text = ready
      ? `Commit ${staged} staged file${staged === 1 ? "" : "s"}`
      : staged === 0
        ? "Stage files to commit"
        : "Write a summary to commit",
    padding = Math.max(0, Math.floor((width - Bun.stringWidth(text)) / 2));
  ctx.commitButton.fg = ready ? oneDarkTheme.added : oneDarkTheme.muted;
  ctx.commitButton.content = new StyledText([
    bg(ready ? oneDarkTheme.selected : oneDarkTheme.panelRaised)(
      fg(ready ? oneDarkTheme.added : oneDarkTheme.muted)(
        fitColumns(`${" ".repeat(padding)}${ready ? "✓ " : ""}${text}`, width),
      ),
    ),
  ]);
  ctx.amendButton.content = `${ctx.amend ? "[x]" : "[ ]"} Amend previous commit`;
  ctx.amendButton.fg = ctx.amend ? oneDarkTheme.warning : oneDarkTheme.muted;
}
