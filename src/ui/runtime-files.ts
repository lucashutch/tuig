import type { TextRenderable } from "@opentui/core";
import { MouseButton } from "@opentui/core";
import type { ChangedFile, RepositorySnapshot } from "../git/types.js";
import {
  cachedFileTree,
  cachedFlattenVisible,
  toggleExpansion,
  descendantFiles,
  fileRowActionHits,
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
  hoveredFileRow?: { section: ChangeSection; row: number };
  preferredUnstagedHeight?: number;
  preferredComposerHeight?: number;
  contentHeight: number;
  commitFilesTop: number;
  diffOrigin?: "working" | "commit";
  selectedCommitSha?: string;
  widgets: {
    unstagedText: TextRenderable;
    stagedText: TextRenderable;
    commitDiff: { visible: boolean };
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
  runFileAction?(
    action: "stage" | "discard" | "unstage",
    files: ChangedFile[],
    directory: boolean,
  ): void;
}

export function filesHover(
  context: RuntimeFilesContext,
  section: ChangeSection,
  y?: number,
) {
  const row = y === undefined ? -1 : y - list(context, section).y;
  const next = row >= 0 ? { section, row } : undefined;
  if (
    context.hoveredFileRow?.section === next?.section &&
    context.hoveredFileRow?.row === next?.row
  )
    return;
  context.hoveredFileRow = next;
  context.paintFiles();
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
  if (context.view === "commit") return context.commitFiles;
  const source = context.snapshot?.files;
  if (!source) return [];
  let cached = filteredFiles.get(source);
  if (!cached) {
    cached = {
      staged: source.filter((file) => file.staged),
      unstaged: source.filter((file) => file.unstaged),
    };
    filteredFiles.set(source, cached);
  }
  return cached[section];
}

// Repository snapshots replace their immutable files array. Weak keys ensure
// old snapshots and their filtered views are collectible.
const filteredFiles = new WeakMap<
  readonly ChangedFile[],
  Record<ChangeSection, ChangedFile[]>
>();

export function sectionRows(
  context: RuntimeFilesContext,
  section: ChangeSection,
): VisibleFileTreeNode[] {
  return cachedFlattenVisible(
    cachedFileTree(files(context, section)),
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
  // Mouse coordinates and the rendered widget position are screen-relative.
  // `top` is only a layout offset and can differ due to the parent's border.
  const row = y - list(context, section).y + context.sectionStart[section];
  const rowEntry = sectionRows(context, section)[row];
  if (!rowEntry) return;
  const { node, depth } = rowEntry;
  if (button === MouseButton.RIGHT) {
    if (node.kind !== "file") return;
    const file = files(context, section).find(
      (candidate) => candidate.path === node.path,
    );
    if (!file) return;
    context.openFileMenu(x ?? 0, y, {
      sha: context.view === "commit" ? (context.selectedCommitSha ?? "") : "",
      file,
      fileStaged: section === "staged",
    });
    return;
  }
  if (
    context.view !== "commit" &&
    button === MouseButton.LEFT &&
    x !== undefined &&
    context.hoveredFileRow?.section === section &&
    context.hoveredFileRow.row === row - context.sectionStart[section]
  ) {
    const localX = x - Number(list(context, section).x);
    const width = Number(list(context, section).width);
    const hit = fileRowActionHits(section, width, 6 + depth * 2).find(
      ({ start, end }) => localX >= start && localX < end,
    );
    if (hit) {
      context.runFileAction?.(
        hit.action,
        descendantFiles(node),
        node.kind === "directory",
      );
      return;
    }
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
  if (context.view !== "commit") void context.openWorkingDiff();
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
