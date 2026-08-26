import { StyledText, fg } from "@opentui/core";
import type {
  ChangedFile,
  Commit,
  GitRepository,
  RepositorySnapshot,
} from "../git/types.js";
import { buildCommitBranchHints, resolveHeadSha } from "./history.js";
import { layoutGraph, type GraphRow } from "./graph.js";
import {
  presentCommitMeta,
  workingChangesBannerLines,
  wrappedLineCount,
} from "./runtime-presentation.js";
import { createRuntimeWidgets, type ChangeSection } from "./runtime-widgets.js";
import { oneDarkTheme } from "./theme.js";

type Widgets = ReturnType<typeof createRuntimeWidgets>;
type View = "history" | "commit" | "working";

export interface RuntimeDataContext {
  repository: GitRepository;
  widgets: Pick<
    Widgets,
    | "history"
    | "historyText"
    | "commitDiff"
    | "commitDiffEmpty"
    | "workingBanner"
    | "unstagedText"
    | "commitInfo"
    | "commitHeader"
    | "commitBody"
    | "commitBodyBox"
    | "commitInfoBox"
  >;
  snapshot?: RepositorySnapshot;
  snapshotRequest: number;
  diffRequest: number;
  commitFilesRequest: number;
  busy: boolean;
  refreshPending: boolean;
  pendingRefreshMessage?: string;
  view: View;
  mode: ChangeSection;
  diffOrigin?: "working" | "commit";
  historySelection: "working" | "commit";
  commitIndex: number;
  fileIndex: number;
  fileStart: number;
  commitFiles: ChangedFile[];
  graphRows: GraphRow[];
  graphColumns: number;
  branchHints: Map<string, string>;
  detailsPaneWidth: number;
  commitInfoValue: string;
  commitHeaderValue: string;
  commitBodyValue: string;
  files(): ChangedFile[];
  selectedFile(): ChangedFile | undefined;
  ensureFileVisible(): void;
  layout(): void;
  paint(): void;
  paintFiles(): void;
  paintHints(): void;
  notify(text: string, tone?: "info" | "error" | "busy"): void;
  fail(error: unknown): void;
  refresh(message?: string): Promise<void>;
}

export async function refresh(ctx: RuntimeDataContext, message?: string) {
  if (ctx.busy) {
    ctx.refreshPending = true;
    ctx.pendingRefreshMessage = message ?? ctx.pendingRefreshMessage;
    return;
  }
  ctx.busy = true;
  const request = ++ctx.snapshotRequest;
  ++ctx.diffRequest;
  ++ctx.commitFilesRequest;
  const preserveCommitDiff =
    ctx.view === "commit" && ctx.widgets.commitDiff.visible;
  const selectedSha = ctx.snapshot?.commits[ctx.commitIndex]?.sha;
  const selectedPath = ctx.selectedFile()?.path;
  ctx.notify(message ?? "Refreshing…", "busy");
  try {
    const snapshot = await ctx.repository.snapshot(1000);
    if (request !== ctx.snapshotRequest || ctx.refreshPending) return;
    ctx.snapshot = snapshot;
    ctx.graphRows = layoutGraph(
      snapshot.commits,
      oneDarkTheme.graph,
      resolveHeadSha(snapshot.branches, snapshot.commits),
    );
    ctx.branchHints = buildCommitBranchHints(
      snapshot.commits,
      snapshot.branches,
    );
    ctx.graphColumns = Math.max(
      1,
      ...ctx.graphRows.map((row) =>
        Math.max(row.cells.length, row.connectors.length),
      ),
    );
    const commitAt = selectedSha
      ? snapshot.commits.findIndex((commit) => commit.sha === selectedSha)
      : -1;
    ctx.commitIndex =
      commitAt >= 0
        ? commitAt
        : Math.min(ctx.commitIndex, Math.max(0, snapshot.commits.length - 1));
    const fileAt = selectedPath
      ? ctx.files().findIndex((file) => file.path === selectedPath)
      : -1;
    ctx.fileIndex =
      fileAt >= 0
        ? fileAt
        : Math.min(ctx.fileIndex, Math.max(0, ctx.files().length - 1));
    ctx.ensureFileVisible();
    ctx.paint();
    if (ctx.view === "commit") {
      await openCommit(ctx);
      if (preserveCommitDiff && ctx.selectedFile()) {
        ctx.diffOrigin = "commit";
        ctx.widgets.commitDiff.visible = true;
        ctx.widgets.commitDiffEmpty.visible = false;
        ctx.layout();
        await loadDiff(ctx);
      }
    }
    ctx.notify("");
  } catch (error) {
    ctx.fail(error);
  } finally {
    ctx.busy = false;
    if (ctx.refreshPending) {
      const trailing = ctx.pendingRefreshMessage;
      ctx.refreshPending = false;
      ctx.pendingRefreshMessage = undefined;
      void ctx.refresh(trailing);
    }
  }
}

export async function loadDiff(ctx: RuntimeDataContext) {
  const token = ++ctx.diffRequest,
    file = ctx.selectedFile(),
    selected = ctx.snapshot?.commits[ctx.commitIndex];
  const snapshot = ctx.snapshot,
    view = ctx.view,
    mode = ctx.mode,
    path = file?.path;
  const value =
    view === "commit" && selected
      ? await ctx.repository.diff({ commit: selected.sha, path, context: 6 })
      : file
        ? await ctx.repository.diff({
            path: file.path,
            staged: mode === "staged",
            context: 6,
          })
        : "";
  if (
    token !== ctx.diffRequest ||
    ctx.snapshot !== snapshot ||
    ctx.view !== view ||
    ctx.mode !== mode ||
    ctx.selectedFile()?.path !== path ||
    (view === "commit" &&
      ctx.snapshot?.commits[ctx.commitIndex]?.sha !== selected?.sha)
  )
    return;
  if (ctx.view !== "history") {
    ctx.widgets.commitDiff.diff = value;
    ctx.widgets.commitDiffEmpty.visible = value.length === 0;
  }
}

export async function openCommit(ctx: RuntimeDataContext) {
  const commit = ctx.snapshot?.commits[ctx.commitIndex];
  if (!commit) return;
  const token = ++ctx.commitFilesRequest;
  ++ctx.diffRequest;
  const snapshot = ctx.snapshot,
    selectedPath = ctx.selectedFile()?.path;
  ctx.view = "commit";
  ctx.diffOrigin = undefined;
  ctx.historySelection = "commit";
  ctx.fileIndex = 0;
  ctx.fileStart = 0;
  ctx.widgets.history.title = undefined;
  ctx.widgets.historyText.visible = true;
  ctx.widgets.commitDiff.visible = false;
  ctx.widgets.commitDiffEmpty.visible = false;
  showCommitMeta(ctx, commit);
  ctx.widgets.workingBanner.content = workingChangesBannerLines(
    ctx.snapshot?.files.length ?? 0,
    Math.max(1, ctx.detailsPaneWidth - 2),
  ).join("\n");
  ctx.widgets.workingBanner.height = ctx.widgets.workingBanner.visible ? 2 : 1;
  ctx.layout();
  ctx.notify("Commit selected · click a changed file for its diff");
  ctx.commitFiles = [];
  ctx.widgets.unstagedText.content = new StyledText([
    fg(oneDarkTheme.muted)("  ░░░░░░░░░░░░░░░\n  ░░░░░░░░░░\n  ░░░░░░░░░░░░"),
  ]);
  ctx.widgets.commitDiffEmpty.content =
    "Select a changed file to open its diff.";
  try {
    const files = await ctx.repository.commitFiles(commit.sha);
    if (
      token !== ctx.commitFilesRequest ||
      ctx.snapshot !== snapshot ||
      ctx.view !== "commit" ||
      ctx.snapshot?.commits[ctx.commitIndex]?.sha !== commit.sha
    )
      return;
    ctx.commitFiles = files;
    const at = selectedPath
      ? files.findIndex((file) => file.path === selectedPath)
      : -1;
    ctx.fileIndex = at >= 0 ? at : 0;
    ctx.ensureFileVisible();
    ctx.paintFiles();
  } catch (error) {
    if (token !== ctx.commitFilesRequest || ctx.snapshot !== snapshot) return;
    const message = error instanceof Error ? error.message : String(error);
    ctx.widgets.unstagedText.content = `  Failed to load changed files\n  ${message}`;
    ctx.notify(message, "error");
  }
}

export async function openWorkingDiff(ctx: RuntimeDataContext) {
  if (!ctx.selectedFile()) return;
  ctx.view = "working";
  ctx.diffOrigin = "working";
  ctx.widgets.history.title = undefined;
  ctx.widgets.commitDiff.visible = true;
  ctx.widgets.commitDiffEmpty.visible = false;
  setCommitMetaVisible(ctx, false);
  ctx.paintHints();
  ctx.layout();
  try {
    await loadDiff(ctx);
  } catch (error) {
    ctx.fail(error);
  }
}

export function closeDiff(ctx: RuntimeDataContext) {
  const returnToCommit = ctx.diffOrigin === "commit";
  ctx.diffOrigin = undefined;
  if (returnToCommit) {
    ctx.view = "commit";
    ctx.historySelection = "commit";
    ctx.widgets.history.title = undefined;
    ctx.widgets.historyText.visible = true;
    ctx.widgets.commitDiff.visible = false;
    ctx.widgets.commitDiffEmpty.visible = false;
    const commit = ctx.snapshot?.commits[ctx.commitIndex];
    if (commit) showCommitMeta(ctx, commit);
    ctx.paintHints();
    ctx.layout();
    ctx.paintFiles();
    return;
  }
  ctx.view = "history";
  ctx.historySelection = "working";
  ctx.commitFiles = [];
  ctx.fileIndex = 0;
  ctx.widgets.history.title = undefined;
  ctx.widgets.historyText.visible = true;
  ctx.widgets.commitDiff.visible = false;
  ctx.widgets.commitDiffEmpty.visible = false;
  setCommitMetaVisible(ctx, false);
  ctx.paintHints();
  ctx.layout();
}

export function showCommitMeta(ctx: RuntimeDataContext, commit: Commit) {
  const meta = presentCommitMeta(commit);
  ctx.widgets.commitInfo.content = meta.info;
  ctx.commitInfoValue = meta.info.chunks.map((chunk) => chunk.text).join("");
  ctx.commitHeaderValue = meta.header;
  ctx.widgets.commitHeader.content = meta.header;
  ctx.commitBodyValue = meta.body;
  ctx.widgets.commitBody.content = meta.body;
  ctx.widgets.commitBody.height = wrappedLineCount(
    meta.body,
    Math.max(10, ctx.detailsPaneWidth - 8),
  );
  ctx.widgets.commitBodyBox.scrollTo(0);
  setCommitMetaVisible(ctx, true);
  ctx.layout();
}

function setCommitMetaVisible(ctx: RuntimeDataContext, visible: boolean) {
  ctx.widgets.commitInfoBox.visible = visible;
  ctx.widgets.commitBodyBox.visible = visible;
}
