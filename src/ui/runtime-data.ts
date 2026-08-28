import { NativeImage, StyledText, fg } from "@opentui/core";
import type {
  ChangedFile,
  Commit,
  GitRepository,
  RepositorySnapshot,
} from "../git/types.js";
import {
  authorAvatar,
  buildCommitBranchHints,
  resolveHeadSha,
} from "./history.js";
import {
  circularAvatar,
  graphAvatarCanvas,
  getGitHubCommitAvatar,
  getGravatarUrl,
  getProviderAvatarUrl,
  loadCachedAvatar,
} from "./avatars.js";
import { layoutGraph, type GraphRow } from "./graph.js";
import {
  presentCommitMeta,
  parseCoAuthors,
  presentCommitCoAuthors,
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
    | "authorPhoto"
    | "authorBadge"
    | "commitCoAuthors"
    | "commitCoAuthorProvider"
    | "graphAvatars"
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
  commitCoAuthorsValue: string;
  commitCoAuthorsProviderVisible: boolean;
  avatarRequest: number;
  avatarAbort?: AbortController;
  avatarSupported: boolean;
  /** Slot identity (sha plus ring color) currently loaded per slot. */
  graphAvatarKeys: Array<string | undefined>;
  /** Monotonic token per slot; stale loads must not paint a newer commit. */
  graphAvatarTokens: number[];
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
  ctx.avatarAbort?.abort();
  const avatarAbort = new AbortController();
  ctx.avatarAbort = avatarAbort;
  const avatarRequest = ++ctx.avatarRequest;
  ctx.widgets.authorPhoto.visible = false;
  ctx.widgets.authorPhoto.source = undefined;
  ctx.widgets.authorBadge.visible = true;
  ctx.widgets.authorBadge.content = authorAvatar(
    commit.author,
    commit.authorEmail,
  );
  const parsedCoAuthors = parseCoAuthors(commit.body);
  const providerEmails = new Set(
    parsedCoAuthors
      .filter((author) => getProviderAvatarUrl(author.name, author.email))
      .map((author) => author.email.toLowerCase()),
  );
  const coAuthors = presentCommitCoAuthors(parsedCoAuthors, providerEmails);
  ctx.widgets.commitCoAuthors.content = coAuthors;
  ctx.commitCoAuthorsValue = coAuthors.chunks
    .map((chunk) => chunk.text)
    .join("");
  const provider = parsedCoAuthors
    .map((author) => getProviderAvatarUrl(author.name, author.email))
    .find(Boolean);
  ctx.commitCoAuthorsProviderVisible = Boolean(provider);
  ctx.widgets.commitCoAuthorProvider.visible = false;
  ctx.widgets.commitCoAuthorProvider.source = undefined;
  if (provider)
    void loadProviderAvatar(ctx, provider, avatarAbort.signal, avatarRequest);
  if (ctx.avatarSupported) {
    const url = getGravatarUrl(commit.authorEmail);
    if (url)
      void loadAuthorPhoto(ctx, commit, url, avatarRequest, avatarAbort.signal);
  }
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

async function loadProviderAvatar(
  ctx: RuntimeDataContext,
  source: string,
  signal: AbortSignal,
  request: number,
) {
  try {
    const image = await loadCachedAvatar(source, signal);
    if (request !== ctx.avatarRequest) {
      image.dispose();
      return;
    }
    ctx.widgets.commitCoAuthorProvider.source = image;
    image.dispose();
    ctx.widgets.commitCoAuthorProvider.visible = true;
  } catch {
    ctx.commitCoAuthorsProviderVisible = false;
    ctx.layout();
  }
}

async function loadAuthorPhoto(
  ctx: RuntimeDataContext,
  commit: Commit,
  url: string,
  request: number,
  signal: AbortSignal,
) {
  try {
    const remote = await ctx.repository.remoteUrl?.();
    const githubAvatar = await getGitHubCommitAvatar(
      remote,
      commit.sha,
      commit.authorEmail,
      signal,
    );
    let image: NativeImage | undefined = githubAvatar
      ? await loadCachedAvatar(githubAvatar, signal).catch(() => undefined)
      : undefined;
    image ??= await loadCachedAvatar(url, signal);
    if (request !== ctx.avatarRequest) {
      image.dispose();
      return;
    }
    ctx.widgets.authorPhoto.source = image;
    // ImageRenderable retains its own reference to the native image.
    image.dispose();
    ctx.widgets.authorPhoto.visible = true;
    ctx.widgets.authorBadge.visible = false;
  } catch {
    // The initials badge is the deliberate fallback for missing or offline avatars.
  }
}

export interface GraphAvatarRequest {
  /** Fixed widget slot. Separate banks avoid moving terminal image placements. */
  slot: number;
  commit: Commit;
  /** Lane color used for the avatar's outline ring. */
  color: string;
  /** Row background the avatar's corners are painted with. */
  background: string;
  /** Position of the commit's graph dot, in history-pane coordinates. */
  left: number;
  top: number;
  continuesAbove: boolean;
  continuesBelow: boolean;
}

const GRAPH_AVATAR_CACHE_SIZE = 256;
const renderedGraphAvatars = new Map<string, NativeImage>();

function graphAvatarKey(request: GraphAvatarRequest) {
  return `${request.commit.sha}|${request.color}|${request.background}|${Number(request.continuesAbove)}${Number(request.continuesBelow)}`;
}

/**
 * Point the pooled graph avatars at the commits currently on screen.
 *
 * Slots keep their commit until another commit claims them, so repainting
 * without a scroll never re-downloads anything. Requests are dropped while a
 * diff overlay covers the history pane, which hides every slot.
 */
export function updateGraphAvatars(
  ctx: RuntimeDataContext,
  requests: readonly GraphAvatarRequest[],
) {
  const slots = ctx.widgets.graphAvatars;
  const requestsBySlot = new Map(
    requests.map((request) => [request.slot, request]),
  );
  for (let slot = 0; slot < slots.length; slot++) {
    const request = requestsBySlot.get(slot);
    const widget = slots[slot]!;
    if (!request) {
      if (ctx.graphAvatarKeys[slot] !== undefined) {
        ctx.graphAvatarKeys[slot] = undefined;
        ctx.graphAvatarTokens[slot] = (ctx.graphAvatarTokens[slot] ?? 0) + 1;
      }
      widget.visible = false;
      widget.source = undefined;
      continue;
    }
    const key = graphAvatarKey(request);
    // Keep each native image anchored to a viewport row. Moving an existing
    // terminal image placement can leave its pixels at the previous row in
    // Kitty and similar graphics protocols.
    if (widget.left !== request.left) widget.left = request.left;
    if (widget.top !== request.top) widget.top = request.top;
    // The ring color is part of the identity: a commit that moved lanes gets
    // its avatar reprocessed with the new lane color.
    if (ctx.graphAvatarKeys[slot] === key) continue;
    ctx.graphAvatarKeys[slot] = key;
    ctx.graphAvatarTokens[slot] = (ctx.graphAvatarTokens[slot] ?? 0) + 1;
    widget.visible = false;
    widget.source = undefined;
    const cached = renderedGraphAvatars.get(key);
    if (cached) {
      renderedGraphAvatars.delete(key);
      renderedGraphAvatars.set(key, cached);
      widget.source = cached;
      widget.visible = true;
      continue;
    }
    if (ctx.avatarSupported)
      void loadGraphAvatar(
        ctx,
        slot,
        key,
        request.commit,
        request.color,
        request.background,
        request.continuesAbove,
        request.continuesBelow,
        ctx.graphAvatarTokens[slot]!,
      );
  }
}

async function loadGraphAvatar(
  ctx: RuntimeDataContext,
  slot: number,
  key: string,
  commit: Commit,
  ringColor: string,
  background: string,
  continuesAbove: boolean,
  continuesBelow: boolean,
  token: number,
) {
  try {
    const remote = await graphRemoteUrl(ctx.repository);
    if (token !== ctx.graphAvatarTokens[slot]) return;
    const githubAvatar = await getGitHubCommitAvatar(
      remote,
      commit.sha,
      commit.authorEmail,
    );
    if (token !== ctx.graphAvatarTokens[slot]) return;
    let image = githubAvatar
      ? await loadCachedAvatar(githubAvatar).catch(() => undefined)
      : undefined;
    const gravatar = getGravatarUrl(commit.authorEmail);
    image ??= gravatar
      ? await loadCachedAvatar(gravatar).catch(() => undefined)
      : undefined;
    if (!image || token !== ctx.graphAvatarTokens[slot]) {
      image?.dispose();
      return;
    }
    const widget = ctx.widgets.graphAvatars[slot]!;
    // `contain` preserves the image's square pixel aspect ratio. Compensating
    // with the reported terminal cell ratio made the shape vary between image
    // placements in some terminal graphics protocols.
    const stretch = 1;
    const masked = circularAvatar(
      image,
      ringColor,
      background,
      stretch,
      `${githubAvatar ?? gravatar}|${ringColor}|${background}|${Number(continuesAbove)}${Number(continuesBelow)}`,
      continuesAbove,
      continuesBelow,
    );
    const canvas = graphAvatarCanvas(masked, background);
    masked.dispose();
    image.dispose();
    if (token !== ctx.graphAvatarTokens[slot]) {
      canvas.dispose();
      return;
    }
    renderedGraphAvatars.set(key, canvas.clone());
    while (renderedGraphAvatars.size > GRAPH_AVATAR_CACHE_SIZE) {
      const oldest = renderedGraphAvatars.entries().next().value as
        | [string, NativeImage]
        | undefined;
      if (!oldest) break;
      renderedGraphAvatars.delete(oldest[0]);
      oldest[1].dispose();
    }
    widget.source = canvas;
    // ImageRenderable retains its own reference to the native image.
    canvas.dispose();
    widget.visible = true;
  } catch {
    // The painted graph dot remains the fallback when avatars are unusable.
  }
}

const graphRemoteUrls = new WeakMap<object, Promise<string | undefined>>();

function graphRemoteUrl(repository: RuntimeDataContext["repository"]) {
  let remote = graphRemoteUrls.get(repository);
  if (!remote) {
    remote = repository.remoteUrl
      ? repository.remoteUrl()
      : Promise.resolve(undefined);
    graphRemoteUrls.set(repository, remote);
  }
  return remote;
}

function setCommitMetaVisible(ctx: RuntimeDataContext, visible: boolean) {
  if (!visible) {
    ctx.avatarAbort?.abort();
    ctx.avatarRequest++;
    ctx.widgets.authorPhoto.source = undefined;
    ctx.widgets.commitCoAuthorProvider.source = undefined;
    ctx.commitCoAuthorsProviderVisible = false;
  }
  ctx.widgets.commitInfoBox.visible = visible;
  ctx.widgets.commitBodyBox.visible = visible;
}
