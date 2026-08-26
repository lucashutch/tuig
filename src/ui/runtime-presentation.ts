import { StyledText, bg, fg } from "@opentui/core";
import type {
  Commit,
  RepositorySnapshot,
  Submodule,
  Worktree,
} from "../git/types.js";
import type { FileTreeNode } from "./file-tree.js";
import {
  branchPresence,
  branchPresenceIcon,
  displayBranchName,
  HEAD_ICON,
  LAPTOP_BRANCH_ICON,
  REMOTE_BRANCH_ICON,
} from "./history.js";
import { shortSha } from "./history.js";
import { oneDarkTheme } from "./theme.js";

/**
 * Row of the LOCAL BRANCHES header inside the repository pane.
 *
 * Sidebar hit testing is arithmetic over the rendered text, so the header rows
 * and the click handlers share these constants instead of restating them.
 */
export const SIDEBAR_LOCAL_HEADER_ROW = 2;
export const SIDEBAR_BRANCH_LIMIT = 10;
export const SIDEBAR_SECTIONS = [
  "local",
  "remote",
  "submodules",
  "stashes",
  "worktrees",
] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
export type SidebarRect = {
  headerTop: number;
  contentTop: number;
  contentHeight: number;
  dividerTop?: number;
};
export const SIDEBAR_MIN_CONTENT_HEIGHT = 3;

/** Single pane-local geometry shared by painting, hit testing and scrolling. */
export function layoutSidebarSections(
  height: number,
  preferred: Record<SidebarSection, number | undefined>,
  collapsed: Record<SidebarSection, boolean>,
): Record<SidebarSection, SidebarRect> {
  const headers = Math.min(Math.max(0, height), SIDEBAR_SECTIONS.length);
  const dividers = Math.min(
    Math.max(0, height - headers),
    SIDEBAR_SECTIONS.length - 1,
  );
  let spare = Math.max(0, height - headers - dividers);
  const open = SIDEBAR_SECTIONS.filter((s) => !collapsed[s]);
  const sizes = Object.fromEntries(
    SIDEBAR_SECTIONS.map((s) => [s, 0]),
  ) as Record<SidebarSection, number>;
  const minimum =
    spare >= open.length * SIDEBAR_MIN_CONTENT_HEIGHT
      ? SIDEBAR_MIN_CONTENT_HEIGHT
      : 0;
  for (const section of open) sizes[section] = minimum;
  spare -= minimum * open.length;
  // If the terminal cannot fit every minimum, degrade evenly rather than
  // overflowing; normal-sized panes always keep three content rows per section.
  if (minimum === 0 && open.length > 0) {
    for (const section of open) {
      const share = Math.floor(spare / open.length);
      sizes[section] = share;
    }
    let assigned = open.reduce((total, section) => total + sizes[section], 0);
    for (const section of open) {
      if (assigned++ >= spare) break;
      sizes[section]++;
    }
    spare = 0;
  }
  const explicit = open.filter((s) => preferred[s] !== undefined);
  const unspecified = open.filter((s) => preferred[s] === undefined);
  const requested = explicit.reduce(
    (total, s) => total + Math.max(0, (preferred[s] ?? minimum) - minimum),
    0,
  );
  if (requested > spare && requested > 0) {
    // A small terminal cannot honour every remembered size; keep their
    // relative order while still consuming exactly the available rows.
    for (const s of explicit) {
      const size = Math.floor(
        (spare * Math.max(0, (preferred[s] ?? minimum) - minimum)) / requested,
      );
      sizes[s] += size;
      spare -= size;
    }
  } else {
    for (const s of explicit) {
      const extra = Math.max(0, (preferred[s] ?? minimum) - minimum);
      sizes[s] += extra;
      spare -= extra;
    }
  }
  const recipients = unspecified.length ? unspecified : open;
  for (const s of recipients) {
    const share = Math.floor(spare / Math.max(1, recipients.length));
    sizes[s] += share;
    spare -= share;
  }
  for (const s of recipients) {
    if (spare-- <= 0) break;
    sizes[s]++;
  }
  let top = 0;
  const result = {} as Record<SidebarSection, SidebarRect>;
  SIDEBAR_SECTIONS.forEach((s, i) => {
    const headerTop = top;
    top += Number(i < headers);
    const contentTop = top;
    top += sizes[s];
    const dividerTop = i < dividers ? top++ : undefined;
    result[s] = { headerTop, contentTop, contentHeight: sizes[s], dividerTop };
  });
  return result;
}

/** Move a divider by changing only the two sections it separates. */
export function resizeSidebarBoundary(
  layout: Record<SidebarSection, SidebarRect>,
  preferred: Record<SidebarSection, number | undefined>,
  collapsed: Record<SidebarSection, boolean>,
  section: SidebarSection,
  y: number,
): Record<SidebarSection, number | undefined> {
  const index = SIDEBAR_SECTIONS.indexOf(section);
  const next = SIDEBAR_SECTIONS.slice(index + 1).find((s) => !collapsed[s]);
  if (collapsed[section] || !next) return preferred;
  const current = layout[section].contentHeight;
  const neighbour = layout[next].contentHeight;
  const total = current + neighbour;
  const minimum =
    total >= SIDEBAR_MIN_CONTENT_HEIGHT * 2 ? SIDEBAR_MIN_CONTENT_HEIGHT : 0;
  const wanted = Math.max(
    minimum,
    Math.min(total - minimum, y - layout[section].contentTop),
  );
  // Materialise every currently rendered height before changing the pair.
  // Leaving undefined preferences behind would cause the allocator to
  // redistribute those sections during this drag, making unrelated dividers
  // visibly move.
  const stable = Object.fromEntries(
    SIDEBAR_SECTIONS.map((candidate) => [
      candidate,
      collapsed[candidate]
        ? preferred[candidate]
        : layout[candidate].contentHeight,
    ]),
  ) as Record<SidebarSection, number | undefined>;
  return { ...stable, [section]: wanted, [next]: total - wanted };
}
export function sidebarHeader(
  section: SidebarSection,
  count: number,
  collapsed: boolean,
) {
  const label =
    section === "local"
      ? "LOCAL BRANCHES"
      : section === "remote"
        ? "REMOTES"
        : section.toUpperCase();
  return `${collapsed ? "▶" : "▼"} ${label} ${count}`;
}
export function sidebarScrollbar(
  total: number,
  start: number,
  viewport: number,
) {
  const size =
    total > viewport
      ? Math.max(1, Math.floor((viewport * viewport) / total))
      : viewport;
  return {
    thumbSize: Math.max(0, size),
    thumbTop:
      total > viewport
        ? Math.floor(
            (Math.max(0, Math.min(total - viewport, start)) /
              (total - viewport)) *
              (viewport - size),
          )
        : 0,
  };
}

/** Render a fixed-height sidebar viewport, including its final scrollbar cell. */
export function renderSidebarViewport(
  rows: readonly string[],
  width: number,
  start: number,
  viewport: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const safeViewport = Math.max(0, viewport);
  const clamped = Math.max(
    0,
    Math.min(Math.max(0, rows.length - safeViewport), start),
  );
  const thumb = sidebarScrollbar(rows.length, clamped, safeViewport);
  const scrollable = rows.length > safeViewport;
  return Array.from({ length: safeViewport }, (_, index) => {
    const row =
      rows[clamped + index] ??
      (rows.length === 0 && index === 0 ? "  (none)" : "");
    const track = scrollable
      ? index >= thumb.thumbTop && index < thumb.thumbTop + thumb.thumbSize
        ? "█"
        : "│"
      : " ";
    return safeWidth === 1
      ? track
      : `${fitColumns(row, safeWidth - 1)}${track}`;
  });
}
export function sidebarRows(
  snapshot: RepositorySnapshot,
  section: SidebarSection,
  width: number,
): string[] {
  if (section === "local" || section === "remote")
    return snapshot.branches
      .filter((b) => (section === "local" ? !b.remote : b.remote))
      .map(
        (b) =>
          `${branchPresenceIcon(branchPresence(b, snapshot.branches), b.current)} ${section === "local" ? LAPTOP_BRANCH_ICON : REMOTE_BRANCH_ICON} ${displayBranchName(b.name)}`,
      );
  if (section === "submodules")
    return snapshot.submodules.flatMap((s) => [
      ` ${s.state === "clean" ? "✓" : s.state === "uninitialized" ? "✖" : "!"} ${submoduleDisplayName(s)}`,
      `   ${s.path}`,
    ]);
  if (section === "stashes")
    return snapshot.stashes.map((s) => ` ◇ ${s.ref} ${s.subject}`);
  return worktreeRows(snapshot.worktrees, snapshot.root, width).map(
    (r) => r.label,
  );
}

export function submoduleDisplayName(submodule: Submodule): string {
  return submodule.path.split("/").filter(Boolean).at(-1) || submodule.path;
}

export function submoduleStatusColor(submodule: Submodule): string {
  if (submodule.state === "clean") return oneDarkTheme.added;
  if (submodule.state === "different") return oneDarkTheme.warning;
  return oneDarkTheme.deleted;
}

/** Styled two-line submodule viewport: status-coloured name, muted path. */
export function renderSubmoduleSidebarViewport(
  submodules: readonly Submodule[],
  width: number,
  start: number,
  viewport: number,
): StyledText {
  const rows = submodules.flatMap((submodule) => [
    ` ${submodule.state === "clean" ? "✓" : submodule.state === "uninitialized" ? "✖" : "!"} ${submoduleDisplayName(submodule)}`,
    `   ${submodule.path}`,
  ]);
  const safeViewport = Math.max(0, viewport);
  const clamped = Math.max(
    0,
    Math.min(Math.max(0, rows.length - safeViewport), start),
  );
  const rendered = renderSidebarViewport(rows, width, clamped, safeViewport);
  return new StyledText(
    rendered.map((line, index) => {
      const rowIndex = clamped + index;
      const submodule = submodules[Math.floor(rowIndex / 2)];
      const color =
        rowIndex % 2 === 0 && submodule
          ? submoduleStatusColor(submodule)
          : oneDarkTheme.muted;
      return fg(color)(`${line}${index + 1 < rendered.length ? "\n" : ""}`);
    }),
  );
}

/** Row of the REMOTES header, which moves with the local branch list. */
export function sidebarRemoteHeaderRow(
  localBranchCount: number,
  localBranchesCollapsed: boolean,
): number {
  const localRows = localBranchesCollapsed
    ? 0
    : Math.min(SIDEBAR_BRANCH_LIMIT, Math.max(1, localBranchCount));
  return SIDEBAR_LOCAL_HEADER_ROW + 2 + localRows;
}

export type SidebarPresentationInput = {
  snapshot: RepositorySnapshot;
  width: number;
  localBranchStart: number;
  remoteBranchStart: number;
  localBranchesCollapsed: boolean;
  remoteBranchesCollapsed: boolean;
};

export type SidebarPresentation = {
  content: StyledText;
  localBranchStart: number;
  remoteBranchStart: number;
};

/**
 * Label every worktree, marking the one this session has open.
 *
 * Worktrees share an object store but not a checkout, so knowing which one is
 * on screen is the difference between a branch being busy elsewhere and being
 * free to switch to.
 */
export function worktreeRows(
  worktrees: readonly Worktree[],
  root: string,
  width = 28,
): Array<{ label: string; current: boolean }> {
  if (worktrees.length === 0) return [{ label: "  (none)", current: false }];
  const normalise = (path: string) => path.replace(/\/+$/, "");
  return worktrees.map((worktree) => {
    const current = normalise(worktree.path) === normalise(root);
    const name = normalise(worktree.path).split("/").at(-1);
    // A wrapped row would spill out of the pane, so names are clipped.
    return {
      label: clipColumns(
        ` ${current ? HEAD_ICON : "⎇"} ${name}${worktree.prunable ? " ⚠" : ""}`,
        Math.max(6, width - 1),
      ),
      current,
    };
  });
}

export function renderSidebar({
  snapshot,
  width,
  localBranchStart: requestedLocalStart,
  remoteBranchStart: requestedRemoteStart,
  localBranchesCollapsed,
  remoteBranchesCollapsed,
}: SidebarPresentationInput): SidebarPresentation {
  const localBranches = snapshot.branches.filter((branch) => !branch.remote);
  const remoteBranches = snapshot.branches.filter((branch) => branch.remote);
  const branchLimit = SIDEBAR_BRANCH_LIMIT;
  const localBranchStart = Math.max(
    0,
    Math.min(requestedLocalStart, localBranches.length - branchLimit),
  );
  const remoteBranchStart = Math.max(
    0,
    Math.min(requestedRemoteStart, remoteBranches.length - branchLimit),
  );
  const formatBranches = (
    branches: typeof localBranches,
    start: number,
    icon: string,
  ) =>
    branches
      .slice(start, start + branchLimit)
      .map(
        (branch) =>
          `${branchPresenceIcon(branchPresence(branch, snapshot.branches), branch.current)} ${icon} ${displayBranchName(branch.name)}`,
      )
      .join("\n") || "  (none)";
  const local = formatBranches(
    localBranches,
    localBranchStart,
    LAPTOP_BRANCH_ICON,
  );
  const remote = formatBranches(
    remoteBranches,
    remoteBranchStart,
    REMOTE_BRANCH_ICON,
  );
  const sectionWidth = Math.max(1, width);
  const fillSection = (value: string) =>
    value
      .split("\n")
      .map((line) => {
        const clipped = ` ${line}`.slice(0, sectionWidth);
        if (clipped.length >= sectionWidth) return clipped;
        // OpenTUI trims a line's final ordinary space while rasterising styled
        // text, which made shorter branch rows lose the last background cell.
        // A non-breaking final cell keeps the full-width section background.
        return `${clipped.padEnd(Math.max(0, sectionWidth - 1))}\u00a0`;
      })
      .join("\n");
  const localBlock = fillSection(
    `${sidebarHeader("local", localBranches.length, localBranchesCollapsed)}${localBranchesCollapsed ? "" : `\n${local}`}`,
  );
  const remoteBlock = fillSection(
    `${sidebarHeader("remote", remoteBranches.length, remoteBranchesCollapsed)}${remoteBranchesCollapsed ? "" : `\n${remote}`}`,
  );
  const repositoryTail = `\n\n SUBMODULES  ${snapshot.submodules.length}\n${snapshot.submodules.map((submodule) => ` ${submodule.state === "clean" ? "✓" : "!"} ${submodule.path}`).join("\n") || "  (none)"}\n\n STASHES  ${snapshot.stashes.length}\n${
    snapshot.stashes
      .slice(0, 6)
      .map((stash) => ` ◇ ${stash.ref} ${stash.subject}`)
      .join("\n") || "  (none)"
  }\n\n WORKTREES  ${snapshot.worktrees.length}\n`;
  return {
    content: new StyledText([
      fg(oneDarkTheme.muted)(" REPOSITORY\n\n"),
      bg(oneDarkTheme.panelRaised)(fg(oneDarkTheme.text)(localBlock)),
      fg(oneDarkTheme.text)("\n\n"),
      bg(oneDarkTheme.panelRaised)(fg(oneDarkTheme.text)(remoteBlock)),
      fg(oneDarkTheme.text)(repositoryTail),
      // The worktree you are in is drawn as its own chunk so it can carry the
      // checked-out marker and colour the rest of the list does not.
      ...worktreeRows(snapshot.worktrees, snapshot.root, width).map(
        (row, index) =>
          fg(row.current ? oneDarkTheme.warning : oneDarkTheme.text)(
            `${index ? "\n" : ""}${row.label}`,
          ),
      ),
    ]),
    localBranchStart,
    remoteBranchStart,
  };
}

export function fileIcon(node: FileTreeNode): string {
  if (node.kind === "directory") return "";
  return {
    modified: "●",
    added: "✚",
    untracked: "✚",
    deleted: "✖",
    renamed: "➜",
    copied: "⧉",
    conflicted: "⚠",
  }[node.state];
}

export function fileColor(node: FileTreeNode): string {
  const state = node.kind === "directory" ? node.status : node.state;
  if (state === "deleted" || state === "conflicted")
    return oneDarkTheme.deleted;
  if (state === "added" || state === "untracked") return oneDarkTheme.added;
  if (state === "renamed" || state === "copied") return oneDarkTheme.accent;
  return oneDarkTheme.warning;
}

export function wrappedLineCount(value: string, width: number): number {
  return Math.max(
    1,
    value
      .split("\n")
      .reduce(
        (lines, line) => lines + Math.max(1, Math.ceil(line.length / width)),
        0,
      ),
  );
}

export function fitColumns(
  value: string,
  width: number,
  ellipsis = false,
): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(value) <= width)
    return value + " ".repeat(width - Bun.stringWidth(value));
  const suffix = ellipsis && width > 1 ? "…" : "";
  const target = width - Bun.stringWidth(suffix);
  let result = "";
  for (const character of value) {
    if (Bun.stringWidth(result + character) > target) break;
    result += character;
  }
  result += suffix;
  return result + " ".repeat(Math.max(0, width - Bun.stringWidth(result)));
}

/** Truncate to a column budget without padding the remainder. */
export function clipColumns(value: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(value) <= width) return value;
  const target = Math.max(0, width - 1);
  let result = "";
  for (const character of value) {
    if (Bun.stringWidth(result + character) > target) break;
    result += character;
  }
  return `${result}…`;
}

export function fileViewportSize(
  view: "history" | "commit" | "working",
  terminalHeight: number,
  commitFilesTop: number,
): number {
  return view === "commit"
    ? Math.max(1, terminalHeight - commitFilesTop - 2)
    : Math.max(1, Math.min(7, terminalHeight - 3));
}

/** Rows the commit composer block occupies at the foot of the changes pane. */
/** A useful editor, rather than the former three-line description field. */
export const COMMIT_COMPOSER_HEIGHT = 12;
export const MIN_COMMIT_COMPOSER_HEIGHT = 6;

export type ChangeSectionLayoutInput = {
  /** Rows the pane can use, excluding the bottom hints row. */
  available: number;
  unstagedRows: number;
  stagedRows: number;
  unstagedCollapsed: boolean;
  stagedCollapsed: boolean;
  /** Persisted height selected by dragging the staged-section divider. */
  preferredUnstagedHeight?: number;
  /** Persisted height selected by dragging the composer divider. */
  preferredComposerHeight?: number;
};

export type ChangeSectionLayout = {
  unstagedTop: number;
  unstagedHeight: number;
  stagedTop: number;
  stagedHeight: number;
  composerTop: number;
  composerHeight: number;
  /** Dedicated rows between the two lists and above the composer. */
  unstagedDividerTop: number;
  composerDividerTop: number;
};

/**
 * Split the changes pane between the unstaged list, the staged list, and the
 * commit composer. By default the divider sits in the middle; a dragged
 * preferred height survives subsequent paints and terminal resizes.
 */
export function layoutChangeSections({
  available,
  unstagedCollapsed,
  stagedCollapsed,
  preferredUnstagedHeight,
  preferredComposerHeight,
}: ChangeSectionLayoutInput): ChangeSectionLayout {
  // Row 0 holds actions.  Both headings and both divider rows are structural:
  // do not let a drag handle sit on the last row of a one-line list.
  const open = Number(!unstagedCollapsed) + Number(!stagedCollapsed);
  const fixedRows = 5; // actions, two headings, two dividers
  const composerMaximum = Math.max(0, available - fixedRows - open);
  const composerHeight = Math.min(
    composerMaximum,
    Math.max(0, preferredComposerHeight ?? COMMIT_COMPOSER_HEIGHT),
  );
  const room = Math.max(0, available - fixedRows - composerHeight);
  let unstagedHeight = 0;
  let stagedHeight = 0;
  if (open === 1) {
    if (unstagedCollapsed) stagedHeight = room;
    else unstagedHeight = room;
  } else if (open === 2) {
    if (room < 2) {
      unstagedHeight = room;
    } else {
      const preferred = preferredUnstagedHeight ?? Math.floor(room / 2);
      unstagedHeight = Math.max(1, Math.min(room - 1, preferred));
    }
    stagedHeight = room - unstagedHeight;
  }
  const unstagedTop = 1;
  const unstagedDividerTop = unstagedTop + 1 + unstagedHeight;
  const stagedTop = unstagedDividerTop + 1;
  const composerDividerTop = stagedTop + 1 + stagedHeight;
  return {
    unstagedTop,
    unstagedHeight,
    stagedTop,
    stagedHeight,
    composerTop: composerDividerTop + 1,
    composerHeight,
    unstagedDividerTop,
    composerDividerTop,
  };
}

export function sidebarToggleTarget(
  y: number,
  localBranchesCollapsed: boolean,
  localBranchCount: number,
): "local" | "remote" | undefined {
  // The text is inset one row inside the pane, so a rendered row N is at y N+1.
  const localHeaderY = SIDEBAR_LOCAL_HEADER_ROW + 1;
  if (y === localHeaderY) return "local";
  const remoteHeaderY =
    sidebarRemoteHeaderRow(localBranchCount, localBranchesCollapsed) + 1;
  return y === remoteHeaderY ? "remote" : undefined;
}

export function sidebarScrollStarts({
  y,
  delta,
  localBranchCount,
  remoteBranchCount,
  localBranchStart,
  remoteBranchStart,
  localBranchesCollapsed,
  remoteBranchesCollapsed,
}: {
  y: number;
  delta: number;
  localBranchCount: number;
  remoteBranchCount: number;
  localBranchStart: number;
  remoteBranchStart: number;
  localBranchesCollapsed: boolean;
  remoteBranchesCollapsed: boolean;
}): { localBranchStart: number; remoteBranchStart: number } {
  const remoteHeaderY =
    sidebarRemoteHeaderRow(localBranchCount, localBranchesCollapsed) + 1;
  if (y < remoteHeaderY && !localBranchesCollapsed)
    return {
      localBranchStart: Math.max(
        0,
        Math.min(
          localBranchCount - SIDEBAR_BRANCH_LIMIT,
          localBranchStart + delta,
        ),
      ),
      remoteBranchStart,
    };
  if (!remoteBranchesCollapsed)
    return {
      localBranchStart,
      remoteBranchStart: Math.max(
        0,
        Math.min(
          remoteBranchCount - SIDEBAR_BRANCH_LIMIT,
          remoteBranchStart + delta,
        ),
      ),
    };
  return { localBranchStart, remoteBranchStart };
}

export function presentCommitMeta(commit: Commit): {
  info: StyledText;
  header: string;
  body: string;
} {
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value));
  const author = `${commit.author}${commit.authorEmail ? ` <${commit.authorEmail}>` : ""}`;
  const committer = `${commit.committer}${commit.committerEmail ? ` <${commit.committerEmail}>` : ""}`;
  return {
    info: new StyledText([
      fg(oneDarkTheme.accent)(`${shortSha(commit.sha)}\n`),
      fg(oneDarkTheme.muted)(
        `Author: ${author}\nAuthored: ${formatDate(commit.authoredAt)}\n`,
      ),
      fg(oneDarkTheme.muted)(
        `Committer: ${committer}\nCommitted: ${formatDate(commit.committedAt)}`,
      ),
    ]),
    header: commit.subject,
    body: commit.body || "(no body)",
  };
}

/** Copy for the commit-inspection escape hatch back to working changes. */
export function workingChangesBanner(fileCount: number): string | undefined {
  if (fileCount <= 0) return undefined;
  return `${fileCount} file change${fileCount === 1 ? "" : "s"} in working directory  ·  View Changes`;
}

/** The notice is deliberately two rows: the action can never be clipped away. */
export function workingChangesBannerLines(
  fileCount: number,
  width: number,
): string[] {
  if (fileCount <= 0) return [];
  return [
    clipColumns(
      `${fileCount} file change${fileCount === 1 ? "" : "s"} in working directory`,
      Math.max(1, width),
    ),
    clipColumns("View Changes", Math.max(1, width)),
  ];
}

/** The banner's geometry derives from repository state, never stale widgets. */
export function workingChangesBannerRows(fileCount: number): number {
  return fileCount > 0 ? 2 : 0;
}

export type HeaderPresentationInput = {
  snapshot?: RepositorySnapshot;
  repositoryRoot: string;
  width: number;
  syncedAt?: number;
  now?: number;
};

/** Relative age used by the header's sync indicator. */
export function formatAge(
  syncedAt: number | undefined,
  now = Date.now(),
): string {
  if (syncedAt === undefined) return "not synced";
  const seconds = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (seconds < 10) return "synced just now";
  if (seconds < 60) return `synced ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `synced ${minutes}m ago`;
  return `synced ${Math.floor(minutes / 60)}h ago`;
}

/**
 * Repository header shown above every pane, so branch and sync state survive
 * collapsing the repository pane.
 */
export function renderHeader({
  snapshot,
  repositoryRoot,
  width,
  syncedAt,
  now,
}: HeaderPresentationInput): StyledText {
  const name = repositoryRoot.split("/").filter(Boolean).at(-1) ?? "repository";
  const raised = oneDarkTheme.panelRaised;
  const segments: Array<{ text: string; color: string }> = [
    { text: ` ◉ ${name}`, color: oneDarkTheme.accent },
  ];
  if (!snapshot) {
    segments.push({ text: "  loading…", color: oneDarkTheme.muted });
  } else {
    segments.push({
      text: `  ${displayBranchName(snapshot.branch ?? "detached HEAD")}`,
      color: oneDarkTheme.warning,
    });
    if (snapshot.ahead > 0)
      segments.push({
        text: `  ↑${snapshot.ahead}`,
        color: oneDarkTheme.added,
      });
    if (snapshot.behind > 0)
      segments.push({
        text: `  ↓${snapshot.behind}`,
        color: oneDarkTheme.deleted,
      });
    if (snapshot.ahead === 0 && snapshot.behind === 0)
      segments.push({
        text: snapshot.upstream ? "  up to date" : "  no upstream",
        color: oneDarkTheme.muted,
      });
    segments.push(
      snapshot.files.length > 0
        ? {
            text: `  ${snapshot.files.length} changed`,
            color: oneDarkTheme.warning,
          }
        : { text: "  clean", color: oneDarkTheme.muted },
    );
  }
  const tail = `${formatAge(syncedAt, now)} `;
  const used = segments.reduce(
    (total, segment) => total + Bun.stringWidth(segment.text),
    0,
  );
  const gap = Math.max(1, width - used - Bun.stringWidth(tail));
  segments.push({ text: " ".repeat(gap) + tail, color: oneDarkTheme.muted });
  return new StyledText(
    segments.map((segment) => bg(raised)(fg(segment.color)(segment.text))),
  );
}

export type ToolbarAction =
  | "fetch"
  | "pull"
  | "push"
  | "stash"
  | "pop"
  | "refresh";

export type ToolbarButton = {
  id: ToolbarAction;
  label: string;
  glyph: string;
  enabled: boolean;
};

export type ToolbarHit = { id: ToolbarAction; start: number; end: number };

export type ToolbarPresentation = {
  content: StyledText;
  hits: ToolbarHit[];
};

/** The toolbar's actions, with the ones the repository cannot do greyed out. */
export function toolbarButtons(
  snapshot: RepositorySnapshot | undefined,
): ToolbarButton[] {
  const tracked = Boolean(snapshot?.upstream);
  return [
    { id: "fetch", label: "Fetch", glyph: "󰇚", enabled: Boolean(snapshot) },
    { id: "pull", label: "Pull", glyph: "↓", enabled: tracked },
    { id: "push", label: "Push", glyph: "↑", enabled: tracked },
    {
      id: "stash",
      label: "Stash",
      glyph: "󰆓",
      enabled: (snapshot?.files.length ?? 0) > 0,
    },
    {
      id: "pop",
      label: "Pop",
      glyph: "󰄼",
      enabled: (snapshot?.stashes.length ?? 0) > 0,
    },
    { id: "refresh", label: "Refresh", glyph: "󰑓", enabled: Boolean(snapshot) },
  ];
}

/**
 * Two centred rows of toolbar buttons: labels above their glyphs, with the
 * column range each button answers to.
 */
export function renderToolbar(
  buttons: ToolbarButton[],
  width: number,
): ToolbarPresentation {
  const gap = 2;
  const cells = buttons.map((button) => ({
    button,
    width:
      Math.max(Bun.stringWidth(button.label), Bun.stringWidth(button.glyph)) +
      gap * 2,
  }));
  const strip = cells.reduce((total, cell) => total + cell.width, 0);
  const lead = Math.max(0, Math.floor((width - strip) / 2));
  const raised = oneDarkTheme.panelRaised;
  const labels = [bg(raised)(" ".repeat(lead))];
  const glyphs = [bg(raised)(" ".repeat(lead))];
  const hits: ToolbarHit[] = [];
  let column = lead;
  for (const { button, width: cellWidth } of cells) {
    const centre = (value: string) => {
      const padding = cellWidth - Bun.stringWidth(value);
      const before = Math.floor(padding / 2);
      return " ".repeat(before) + value + " ".repeat(padding - before);
    };
    const labelColor = button.enabled ? oneDarkTheme.text : oneDarkTheme.border;
    const glyphColor = button.enabled
      ? oneDarkTheme.accent
      : oneDarkTheme.border;
    labels.push(bg(raised)(fg(labelColor)(centre(button.label))));
    glyphs.push(bg(raised)(fg(glyphColor)(centre(button.glyph))));
    if (button.enabled)
      hits.push({ id: button.id, start: column, end: column + cellWidth });
    column += cellWidth;
  }
  const trail = Math.max(0, width - column);
  labels.push(bg(raised)(" ".repeat(trail)));
  glyphs.push(bg(raised)(" ".repeat(trail)), fg(oneDarkTheme.border)(""));
  return {
    content: new StyledText([...labels, bg(raised)("\n"), ...glyphs]),
    hits,
  };
}

/** The toolbar button, if any, under a click. */
export function toolbarHit(
  hits: ToolbarHit[],
  x: number,
): ToolbarAction | undefined {
  return hits.find((hit) => x >= hit.start && x < hit.end)?.id;
}

export type HintContext = {
  focus: "history" | "changes";
  view: "history" | "commit" | "working";
  composing: boolean;
};

/**
 * Keybinding hints for the current focus, so the bottom row keeps teaching
 * the keys that actually apply right now.
 */
export function formatHints({ focus, view, composing }: HintContext): string {
  if (composing) return "COMPOSER  ↵ commit  ⇥ summary/description  esc cancel";
  const shared = "⇥ pane  [ ] collapse  r refresh  q quit";
  if (view !== "history")
    return `${focus === "changes" ? "CHANGES" : "DIFF"}  esc back to graph  ←/→ file  s stage  u unstage  ${shared}`;
  if (focus === "changes")
    return `CHANGES  ←/→ file  s stage  u unstage  h hunk  t section  c commit  ${shared}`;
  return `HISTORY  j/k move  ↵ open commit  dbl-click branch checkout  right-click actions  ${shared}`;
}
