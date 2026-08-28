import type { DiffRenderable, TextRenderable } from "@opentui/core";
import { MouseButton } from "@opentui/core";
import type { ChangedFile, RepositorySnapshot } from "../git/types.js";
import {
  buildFileTree,
  flattenVisible,
  toggleExpansion,
  type VisibleFileTreeNode,
} from "./file-tree.js";
import { type ChangeSection } from "./runtime-widgets.js";

/** Widgets and state used by the changed-files panes. */
export interface RuntimeFilesContext {
  snapshot?: RepositorySnapshot;
  commitFiles: ChangedFile[];
  view: "history" | "commit" | "working";
  mode: ChangeSection;
  fileIndex: number;
  fileStart: number;
  sectionCollapsed: Record<ChangeSection, boolean>;
  sectionStart: Record<ChangeSection, number>;
  expandedFiles: Set<string>;
  preferredUnstagedHeight?: number;
  preferredComposerHeight?: number;
  contentHeight: number;
  commitFilesTop: number;
  diffOrigin?: "working" | "commit";
  widgets: {
    unstagedText: TextRenderable;
    stagedText: TextRenderable;
    commitDiff: DiffRenderable;
    commitDiffEmpty: TextRenderable;
  };
  sectionViewport(section: ChangeSection): number;
  setFocus(focus: "history" | "changes"): void;
  layout(): void;
  paint(): void;
  paintFiles(): void;
  loadDiff(): Promise<void>;
  openWorkingDiff(): Promise<void>;
  notify(text: string): void;
  fail(error: unknown): void;
  persistLayoutPreferences(): void;
  /** Opens a context menu for a right-clicked file row. */
  openFileMenu(
    x: number,
    y: number,
    target: {
      sha: string;
      file: ChangedFile;
      fileStaged: boolean;
    },
  ): void;
}

function list(
  context: RuntimeFilesContext,
  section: ChangeSection,
): TextRenderable {
  return section === "unstaged"
    ? context.widgets.unstagedText
    : context.widgets.stagedText;
}

export function files(
  context: RuntimeFilesContext,
  section: ChangeSection = context.mode,
): ChangedFile[] {
  return context.view === "commit"
    ? context.commitFiles
    : (context.snapshot?.files ?? []).filter((file) =>
        section === "staged" ? file.staged : file.unstaged,
      );
}

export function sectionRows(
  context: RuntimeFilesContext,
  section: ChangeSection,
): VisibleFileTreeNode[] {
  return flattenVisible(
    buildFileTree(files(context, section)),
    context.expandedFiles,
  );
}

export function filesViewport(context: RuntimeFilesContext): number {
  return Math.max(1, context.sectionViewport(context.mode));
}

export function toggleSection(
  context: RuntimeFilesContext,
  section: ChangeSection,
) {
  if (context.view === "commit") return;
  context.sectionCollapsed[section] = !context.sectionCollapsed[section];
  context.layout();
}

export function resizeChangeSplit(context: RuntimeFilesContext, y: number) {
  if (context.view !== "history") return;
  // Labels are positioned within the pane; the staged label starts after the
  // unstaged heading and list, so its row directly expresses the split.
  context.preferredUnstagedHeight = Math.max(0, y - 2);
  context.persistLayoutPreferences();
  context.layout();
}

export function resizeComposer(context: RuntimeFilesContext, y: number) {
  if (context.view !== "history") return;
  // y is pane-relative (the widget explicitly removes PANE_TOP). Everything
  // below the divider belongs to the composer.
  context.preferredComposerHeight = Math.max(0, context.contentHeight - 2 - y);
  context.persistLayoutPreferences();
  context.layout();
}

export function filesScroll(
  context: RuntimeFilesContext,
  section: ChangeSection,
  delta: number,
) {
  context.setFocus("changes");
  const rows = sectionRows(context, section);
  context.sectionStart[section] = Math.max(
    0,
    Math.min(
      Math.max(0, rows.length - context.sectionViewport(section)),
      context.sectionStart[section] + delta,
    ),
  );
  if (section === context.mode)
    context.fileStart = context.sectionStart[section];
  context.paintFiles();
}

export function filesClick(
  context: RuntimeFilesContext,
  section: ChangeSection,
  y: number,
  button?: number,
  x?: number,
) {
  context.setFocus("changes");
  if (context.view !== "commit" && section !== context.mode) {
    context.mode = section;
    context.fileStart = context.sectionStart[section];
    context.fileIndex = 0;
  }
  const row =
    y - Number(list(context, section).top) + context.sectionStart[section];
  const node = sectionRows(context, section)[row]?.node;
  if (!node) return;
  if (button === MouseButton.RIGHT) {
    if (context.view !== "history" || node.kind !== "file") return;
    const file = files(context).find(
      (candidate) => candidate.path === node.path,
    );
    if (!file) return;
    context.openFileMenu(x ?? 0, y, {
      sha: "",
      file,
      fileStaged: section === "staged",
    });
    return;
  }
  if (node.kind === "directory") {
    context.expandedFiles = toggleExpansion(context.expandedFiles, node.path);
    context.paintFiles();
    return;
  }
  context.fileIndex = Math.max(
    0,
    files(context).findIndex((file) => file.path === node.path),
  );
  ensureFileVisible(context);
  context.paintFiles();
  if (context.view === "history") void context.openWorkingDiff();
  else {
    context.diffOrigin = "commit";
    context.widgets.commitDiff.visible = true;
    context.widgets.commitDiffEmpty.visible = false;
    context.layout();
    void context.loadDiff().catch((error) => context.fail(error));
  }
}

export function selectedFile(
  context: RuntimeFilesContext,
): ChangedFile | undefined {
  return files(context)[context.fileIndex];
}

export function ensureFileVisible(
  context: RuntimeFilesContext,
  rows = sectionRows(context, context.mode),
) {
  const path = selectedFile(context)?.path;
  const selectedRow = path
    ? rows.findIndex(({ node }) => node.path === path)
    : -1;
  const limit = filesViewport(context);
  const maxStart = Math.max(0, rows.length - limit);
  if (selectedRow >= 0) {
    if (selectedRow < context.fileStart) context.fileStart = selectedRow;
    else if (selectedRow >= context.fileStart + limit)
      context.fileStart = selectedRow - limit + 1;
  }
  context.fileStart = Math.max(0, Math.min(maxStart, context.fileStart));
}

export function moveFile(context: RuntimeFilesContext, delta: number) {
  context.setFocus("changes");
  context.fileIndex = Math.max(
    0,
    Math.min(Math.max(0, files(context).length - 1), context.fileIndex + delta),
  );
  ensureFileVisible(context);
  context.paintFiles();
  if (context.view !== "history")
    void context.loadDiff().catch((error) => context.fail(error));
}
