import { ImageRenderable, NativeImage, StyledText, fg } from "@opentui/core";
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
  fallbackAvatar,
  getGitHubCommitAvatar,
  getGravatarUrl,
  getProviderAvatarUrl,
  loadCachedAvatar,
} from "./avatars.js";
import { DEFAULT_HISTORY_PAGE } from "../git/repository.js";
import { debugLog } from "./debug-log.js";
import {
  layoutGraphFrom,
  type GraphLayoutState,
  type GraphRow,
} from "./graph.js";
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
    | "ensureGraphAvatarSlots"
  >;
  snapshot?: RepositorySnapshot;
  /** Fingerprint of the painted snapshot, used to skip unchanged refreshes. */
  snapshotSignature?: string;
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
  /** Lane state after the last laid-out row, so a new page resumes the fold. */
  graphLayoutState?: GraphLayoutState;
  graphColumns: number;
  /** Commits currently asked of Git. Grows as the viewport nears the end. */
  historyLimit: number;
  /** Guard so one page loads at a time. */
  loadingMoreCommits: boolean;
  /** Consecutive failed page reads; paging stops once it hits the limit. */
  historyPageFailures: number;
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
  /** In-flight load per slot, aborted when the slot changes commit or closes. */
  graphAvatarAborts: Array<AbortController | undefined>;
  files(): ChangedFile[];
  selectedFile(): ChangedFile | undefined;
  ensureFileVisible(): void;
  layout(): void;
  paint(): void;
  paintFiles(): void;
  paintHistory(): void;
  paintHints(): void;
  notify(text: string, tone?: "info" | "error" | "busy"): void;
  fail(error: unknown): void;
  refresh(message?: string): Promise<void>;
}

/**
 * Fingerprint the parts of a snapshot the interface actually draws.
 *
 * A refresh that changes nothing is the common case: the ten-second timer,
 * and any mutation that turns out to be a no-op. Repainting anyway is not free
 * — it rebuilds every sidebar section and reassigns every graph avatar slot —
 * so an unchanged snapshot is dropped before it reaches the widgets. Commit
 * bodies and timestamps are excluded because a commit's content cannot change
 * without its object name changing.
 */
export function snapshotSignature(snapshot: RepositorySnapshot): string {
  const parts: string[] = [
    snapshot.root,
    snapshot.branch ?? "",
    snapshot.upstream ?? "",
    `${snapshot.ahead}/${snapshot.behind}`,
  ];
  for (const file of snapshot.files)
    parts.push(
      `f${file.path}\u0000${file.originalPath ?? ""}\u0000${file.state}${Number(file.staged)}${Number(file.unstaged)}`,
    );
  for (const branch of snapshot.branches)
    parts.push(
      `b${branch.fullName}\u0000${branch.sha}${Number(branch.current)}${Number(branch.remote)}\u0000${branch.upstream ?? ""}`,
    );
  for (const commit of snapshot.commits)
    parts.push(`c${commit.sha}\u0000${commit.decorations.join(",")}`);
  for (const stash of snapshot.stashes)
    parts.push(`s${stash.ref}\u0000${stash.sha}\u0000${stash.subject}`);
  for (const worktree of snapshot.worktrees)
    parts.push(
      `w${worktree.path}\u0000${worktree.sha}\u0000${worktree.locked ?? ""}\u0000${worktree.prunable ?? ""}`,
    );
  for (const submodule of snapshot.submodules)
    parts.push(`m${submodule.path}${submodule.sha}${submodule.state}`);
  return parts.join("\u0001");
}

/**
 * Re-read only the working tree.
 *
 * Staging, unstaging, and discarding cannot change history, so they avoid the
 * snapshot's history walk, which dominates refresh time on large repositories.
 * Implementations without the fast path fall back to a full refresh.
 */
export async function refreshWorkingStatus(
  ctx: RuntimeDataContext,
  message?: string,
) {
  const readStatus = ctx.repository.workingStatus?.bind(ctx.repository);
  if (!readStatus || !ctx.snapshot) return refresh(ctx, message);
  if (ctx.busy) {
    ctx.refreshPending = true;
    ctx.pendingRefreshMessage = message ?? ctx.pendingRefreshMessage;
    return;
  }
  ctx.busy = true;
  const request = ++ctx.snapshotRequest;
  const base = ctx.snapshot;
  const selectedPath = ctx.selectedFile()?.path;
  ctx.notify(message ?? "Refreshing…", "busy");
  try {
    const status = await readStatus();
    if (request !== ctx.snapshotRequest || ctx.refreshPending) return;
    if (ctx.snapshot !== base) return;
    const next: RepositorySnapshot = { ...base, ...status };
    const signature = snapshotSignature(next);
    if (signature === ctx.snapshotSignature) {
      ctx.notify("");
      return;
    }
    ctx.snapshotSignature = signature;
    ctx.snapshot = next;
    // History is untouched, so the graph layout and branch hints still apply.
    const fileAt = selectedPath
      ? ctx.files().findIndex((file) => file.path === selectedPath)
      : -1;
    ctx.fileIndex =
      fileAt >= 0
        ? fileAt
        : Math.min(ctx.fileIndex, Math.max(0, ctx.files().length - 1));
    ctx.ensureFileVisible();
    ctx.paint();
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

/** Widest row, so every graph row is padded to one column count. */
function graphColumnsFor(rows: readonly GraphRow[]): number {
  let columns = 1;
  for (const row of rows)
    columns = Math.max(columns, row.cells.length, row.connectors.length);
  return columns;
}

/** Commits added each time the viewport approaches the end of the graph. */
export const HISTORY_PAGE = DEFAULT_HISTORY_PAGE;
/** Consecutive failed page reads after which paging gives up for this run. */
export const HISTORY_PAGE_FAILURE_LIMIT = 3;
/** Re-reads a refresh will make while pages keep landing underneath it. */
const HISTORY_REREAD_LIMIT = 2;
/**
 * Distance from the last loaded row at which the next page is fetched. One
 * page is 250 rows, so the read starts while fifty rows are still unseen.
 */
export const HISTORY_PREFETCH_ROWS = 50;

/**
 * Extend the loaded history by one page.
 *
 * Only the new commits are read: Git skips the rows already on screen, which
 * keeps the cost of a page flat instead of growing with how far the reader has
 * scrolled. The two reads are separate walks, so the last known commit is
 * fetched again and compared. When it matches, the page is appended and only
 * the new rows are laid out; when refs moved underneath, the whole range is
 * re-read and the lanes rebuilt.
 */
export async function loadMoreCommits(ctx: RuntimeDataContext) {
  const readPage = ctx.repository.commitPage?.bind(ctx.repository);
  const base = ctx.snapshot;
  if (
    !readPage ||
    !base ||
    base.commitsComplete ||
    ctx.loadingMoreCommits ||
    ctx.historyPageFailures >= HISTORY_PAGE_FAILURE_LIMIT
  )
    return;
  ctx.loadingMoreCommits = true;
  const loaded = base.commits.length;
  const last = base.commits[loaded - 1];
  let appended = false;
  try {
    const page = last
      ? await readPage(HISTORY_PAGE + 1, loaded - 1)
      : await readPage(HISTORY_PAGE);
    // A refresh that landed first already replaced the history being extended.
    if (ctx.snapshot !== base) return;
    ctx.historyPageFailures = 0;
    // The overlapping commit must match on its parents too: an amend or a
    // one-commit rebase above the boundary leaves the count, and therefore
    // the commit at this position, unchanged while the rest has moved.
    const overlap = last ? page.commits[0] : undefined;
    const aligned =
      !last ||
      (overlap?.sha === last.sha &&
        overlap.parents.join(" ") === last.parents.join(" "));
    if (!aligned) {
      // Refs moved underneath the walk. A full refresh is owed anyway: it
      // re-reads the refs this page would otherwise lay out against, and it
      // re-resolves the selected commit against the rebuilt list.
      ctx.historyLimit += HISTORY_PAGE;
      debugLog("history", `history diverged at ${loaded} commits; refreshing`);
      await ctx.refresh();
      return;
    }
    const fresh = last ? page.commits.slice(1) : page.commits;
    const commits = last ? [...base.commits, ...fresh] : fresh;
    ctx.historyLimit = commits.length;
    const snapshot: RepositorySnapshot = {
      ...base,
      commits,
      // Nothing new despite an incomplete page: treat history as exhausted
      // rather than asking again on the next paint.
      commitsComplete: page.complete || fresh.length === 0,
    };
    const laidOut = layoutGraphFrom(
      fresh,
      oneDarkTheme.graph,
      resolveHeadSha(base.branches, commits),
      ctx.graphLayoutState,
    );
    ctx.graphRows = [...ctx.graphRows, ...laidOut.rows];
    ctx.graphLayoutState = laidOut.state;
    ctx.graphColumns = graphColumnsFor(ctx.graphRows);
    // Both of these are rebuilt over the whole loaded range, so a page costs
    // more the deeper the reader has scrolled. Measured at 55ms for the page
    // that reaches 20000 commits, against 24ms for the first few.
    ctx.branchHints = buildCommitBranchHints(commits, base.branches);
    ctx.snapshot = snapshot;
    ctx.snapshotSignature = snapshotSignature(snapshot);
    debugLog(
      "history",
      `appended ${fresh.length} commits (${commits.length} loaded, complete=${snapshot.commitsComplete})`,
    );
    appended = true;
  } catch (error) {
    // History already on screen stays usable, so a failed page is not fatal.
    // Repeated failures stop the paint path spawning a git process per frame.
    ctx.historyPageFailures++;
    debugLog("history", `loading history past ${loaded} commits failed`, error);
  } finally {
    ctx.loadingMoreCommits = false;
  }
  // Painted outside the guard so a page that lands short of the viewport can
  // immediately ask for the next one.
  if (appended) ctx.paintHistory();
}

export async function refresh(ctx: RuntimeDataContext, message?: string) {
  if (ctx.busy) {
    ctx.refreshPending = true;
    ctx.pendingRefreshMessage = message ?? ctx.pendingRefreshMessage;
    return;
  }
  ctx.busy = true;
  const request = ++ctx.snapshotRequest;
  const preserveCommitDiff =
    ctx.view === "commit" && ctx.widgets.commitDiff.visible;
  const selectedSha = ctx.snapshot?.commits[ctx.commitIndex]?.sha;
  const selectedPath = ctx.selectedFile()?.path;
  ctx.notify(message ?? "Refreshing…", "busy");
  try {
    // A page can land while this read is in flight. Re-read at the deeper
    // limit rather than replacing the snapshot with a shorter history, which
    // would throw away the new rows and collapse the reader's scroll position.
    let snapshot = await ctx.repository.snapshot(ctx.historyLimit);
    for (
      let attempt = 0;
      attempt < HISTORY_REREAD_LIMIT &&
      snapshot.commits.length < ctx.historyLimit &&
      !snapshot.commitsComplete;
      attempt++
    )
      snapshot = await ctx.repository.snapshot(ctx.historyLimit);
    if (request !== ctx.snapshotRequest || ctx.refreshPending) return;
    ctx.historyPageFailures = 0;
    const signature = snapshotSignature(snapshot);
    // Keep the existing snapshot object: in-flight diff and commit-file loads
    // guard on its identity and would otherwise be discarded for no reason.
    if (ctx.snapshot && signature === ctx.snapshotSignature) {
      ctx.notify("");
      return;
    }
    ctx.snapshotSignature = signature;
    // Replacing the snapshot invalidates every load that guards on its
    // identity, so the in-flight diff and commit files are dropped here rather
    // than before the unchanged-snapshot check above.
    ++ctx.diffRequest;
    ++ctx.commitFilesRequest;
    ctx.snapshot = snapshot;
    const laidOut = layoutGraphFrom(
      snapshot.commits,
      oneDarkTheme.graph,
      resolveHeadSha(snapshot.branches, snapshot.commits),
    );
    ctx.graphRows = laidOut.rows;
    ctx.graphLayoutState = laidOut.state;
    ctx.branchHints = buildCommitBranchHints(
      snapshot.commits,
      snapshot.branches,
    );
    ctx.graphColumns = graphColumnsFor(ctx.graphRows);
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
  } catch (error) {
    debugLog("avatar", `co-author provider avatar failed for ${source}`, error);
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
  } catch (error) {
    // The initials badge is the deliberate fallback for missing or offline avatars.
    debugLog("avatar", `author photo failed for ${commit.sha}`, error);
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

/** Identity of a painted avatar: commit, lane color, row stripe, lane ends. */
function graphAvatarKey(
  identity: string,
  request: Pick<
    GraphAvatarRequest,
    "color" | "background" | "continuesAbove" | "continuesBelow"
  >,
) {
  return `${identity}|${request.color}|${request.background}|${Number(request.continuesAbove)}${Number(request.continuesBelow)}`;
}

function evictRenderedGraphAvatars() {
  while (renderedGraphAvatars.size > GRAPH_AVATAR_CACHE_SIZE) {
    const oldest = renderedGraphAvatars.entries().next().value as
      | [string, NativeImage]
      | undefined;
    if (!oldest) break;
    renderedGraphAvatars.delete(oldest[0]);
    oldest[1].dispose();
  }
}

/** Hand a widget its own reference so cache eviction cannot dispose it. */
function showGraphAvatar(widget: ImageRenderable, image: NativeImage) {
  const owned = image.clone();
  widget.source = owned;
  // ImageRenderable retains its own reference to the native image.
  owned.dispose();
  widget.visible = true;
}

function releaseSlot(ctx: RuntimeDataContext, slot: number) {
  ctx.graphAvatarAborts[slot]?.abort();
  ctx.graphAvatarAborts[slot] = undefined;
  ctx.graphAvatarTokens[slot] = (ctx.graphAvatarTokens[slot] ?? 0) + 1;
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
  // Slots are viewport rows, so requests are dense and small. Indexing them
  // into an array avoids allocating a Map on every paint.
  const requestsBySlot: Array<GraphAvatarRequest | undefined> = [];
  let highest = -1;
  for (const request of requests) {
    if (request.slot < 0) continue;
    requestsBySlot[request.slot] = request;
    if (request.slot > highest) highest = request.slot;
  }
  ctx.widgets.ensureGraphAvatarSlots(highest + 1);
  const slots = ctx.widgets.graphAvatars;
  // Past the last request every slot is either already idle or being cleared,
  // so walk only as far as the deepest slot that has ever been claimed.
  const limit = Math.min(
    slots.length,
    Math.max(highest + 1, ctx.graphAvatarKeys.length),
  );
  for (let slot = 0; slot < limit; slot++) {
    const request = requestsBySlot[slot];
    const widget = slots[slot]!;
    if (!request) {
      if (ctx.graphAvatarKeys[slot] !== undefined) {
        ctx.graphAvatarKeys[slot] = undefined;
        releaseSlot(ctx, slot);
      }
      widget.visible = false;
      widget.source = undefined;
      continue;
    }
    const key = graphAvatarKey(request.commit.sha, request);
    // Keep each native image anchored to a viewport row. Moving an existing
    // terminal image placement can leave its pixels at the previous row in
    // Kitty and similar graphics protocols.
    if (widget.left !== request.left) widget.left = request.left;
    if (widget.top !== request.top) widget.top = request.top;
    if (!ctx.avatarSupported) {
      if (ctx.graphAvatarKeys[slot] !== undefined) {
        ctx.graphAvatarKeys[slot] = undefined;
        releaseSlot(ctx, slot);
      }
      widget.visible = false;
      widget.source = undefined;
      continue;
    }
    // The ring color is part of the identity: a commit that moved lanes gets
    // its avatar reprocessed with the new lane color.
    if (ctx.graphAvatarKeys[slot] === key) continue;
    ctx.graphAvatarKeys[slot] = key;
    releaseSlot(ctx, slot);
    widget.visible = false;
    widget.source = undefined;
    const cached = renderedGraphAvatars.get(key);
    if (cached) {
      renderedGraphAvatars.delete(key);
      renderedGraphAvatars.set(key, cached);
      showGraphAvatar(widget, cached);
      continue;
    }
    const fallback = fallbackAvatar(
      request.commit.authorEmail || request.commit.author || request.commit.sha,
      {
        ringColor: request.color,
        background: request.background,
        continuesAbove: request.continuesAbove,
        continuesBelow: request.continuesBelow,
      },
    );
    showGraphAvatar(widget, fallback);
    fallback.dispose();
    const abort = new AbortController();
    ctx.graphAvatarAborts[slot] = abort;
    void loadGraphAvatar(
      ctx,
      slot,
      key,
      request,
      ctx.graphAvatarTokens[slot]!,
      abort.signal,
    );
  }
}

/** Cancel every in-flight graph avatar load, for teardown. */
export function cancelGraphAvatars(ctx: RuntimeDataContext) {
  for (let slot = 0; slot < ctx.graphAvatarAborts.length; slot++)
    releaseSlot(ctx, slot);
}

async function loadGraphAvatar(
  ctx: RuntimeDataContext,
  slot: number,
  key: string,
  request: GraphAvatarRequest,
  token: number,
  signal: AbortSignal,
) {
  const { commit } = request;
  const current = () =>
    token === ctx.graphAvatarTokens[slot] && !signal.aborted;
  try {
    const remote = await graphRemoteUrl(ctx.repository);
    if (!current()) return;
    const githubAvatar = await getGitHubCommitAvatar(
      remote,
      commit.sha,
      commit.authorEmail,
      signal,
    );
    if (!current()) return;
    let image = githubAvatar
      ? await loadCachedAvatar(githubAvatar, signal).catch(() => undefined)
      : undefined;
    const gravatar = getGravatarUrl(commit.authorEmail);
    image ??= gravatar
      ? await loadCachedAvatar(gravatar, signal).catch(() => undefined)
      : undefined;
    if (!image || !current()) {
      image?.dispose();
      return;
    }
    const canvas = circularAvatar(image, {
      ringColor: request.color,
      background: request.background,
      continuesAbove: request.continuesAbove,
      continuesBelow: request.continuesBelow,
      // Two commits by the same author in the same lane share one canvas, so
      // the mask keys on the avatar rather than the commit.
      cacheKey: graphAvatarKey(githubAvatar ?? gravatar ?? "", request),
    });
    image.dispose();
    if (!current()) {
      canvas.dispose();
      return;
    }
    renderedGraphAvatars.set(key, canvas);
    evictRenderedGraphAvatars();
    showGraphAvatar(ctx.widgets.graphAvatars[slot]!, canvas);
  } catch (error) {
    // The painted graph dot remains the fallback when avatars are unusable.
    debugLog("graph-avatar", `slot ${slot} (${key}) failed`, error);
  }
}

const graphRemoteUrls = new WeakMap<object, Promise<string | undefined>>();

function graphRemoteUrl(repository: RuntimeDataContext["repository"]) {
  let remote = graphRemoteUrls.get(repository);
  if (!remote) {
    remote = repository.remoteUrl
      ? // A rejected promise must not stick: one failed `git remote` would
        // otherwise disable avatars for the rest of the session.
        repository.remoteUrl().catch((error: unknown) => {
          graphRemoteUrls.delete(repository);
          debugLog("graph-avatar", "remote lookup failed", error);
          return undefined;
        })
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
