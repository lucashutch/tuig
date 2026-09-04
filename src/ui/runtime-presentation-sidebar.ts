import { StyledText, bg, fg } from "@opentui/core";
import type {
  RepositorySnapshot,
  Stash,
  Submodule,
  Worktree,
} from "../git/types.js";
import {
  branchPresenceFromIndex,
  branchRefFilter,
  branchPresenceIcon,
  presenceIndexFor,
  displayBranchName,
  filterBranchRefs,
  HEAD_ICON,
  LAPTOP_BRANCH_ICON,
  REMOTE_BRANCH_ICON,
} from "./history.js";
import { clipColumns, fitColumns } from "./runtime-presentation-text.js";
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
  branchFilter = "",
): string[] {
  if (section === "local" || section === "remote") {
    const remote = section === "remote";
    const icon = remote ? REMOTE_BRANCH_ICON : LAPTOP_BRANCH_ICON;
    // One index for the whole section keeps presence lookups constant time.
    const presenceIndex = presenceIndexFor(snapshot.branches);
    const matches = branchRefFilter(branchFilter);
    const rows: string[] = [];
    for (const b of snapshot.branches) {
      if (b.remote !== remote || !matches(b)) continue;
      rows.push(
        `${branchPresenceIcon(branchPresenceFromIndex(b, presenceIndex), b.current)} ${icon} ${displayBranchName(b.name)}`,
      );
    }
    return rows;
  }
  if (section === "submodules")
    return snapshot.submodules.flatMap((s) => [
      ` ${s.state === "clean" ? "✓" : s.state === "uninitialized" ? "✖" : "!"} ${submoduleDisplayName(s)}`,
      `   ${s.path}`,
    ]);
  if (section === "stashes")
    return snapshot.stashes.flatMap((s) => [
      ` ◇ ${s.subject}`,
      `   on ${s.branch ?? "unknown branch"} • ${s.createdAt}`,
    ]);
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

/** Styled two-line stash viewport: subject, then muted branch and age. */
export function renderStashSidebarViewport(
  stashes: readonly Stash[],
  width: number,
  start: number,
  viewport: number,
): StyledText {
  const rows = stashes.flatMap((stash) => [
    ` ◇ ${stash.subject}`,
    `   on ${stash.branch ?? "unknown branch"} • ${stash.createdAt}`,
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
      const color = rowIndex % 2 === 0 ? oneDarkTheme.text : oneDarkTheme.muted;
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
  branchFilter?: string;
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
  branchFilter = "",
}: SidebarPresentationInput): SidebarPresentation {
  const localBranches = filterBranchRefs(
    snapshot.branches.filter((branch) => !branch.remote),
    branchFilter,
  );
  const remoteBranches = filterBranchRefs(
    snapshot.branches.filter((branch) => branch.remote),
    branchFilter,
  );
  const branchLimit = SIDEBAR_BRANCH_LIMIT;
  const localBranchStart = Math.max(
    0,
    Math.min(requestedLocalStart, localBranches.length - branchLimit),
  );
  const remoteBranchStart = Math.max(
    0,
    Math.min(requestedRemoteStart, remoteBranches.length - branchLimit),
  );
  const presenceIndex = presenceIndexFor(snapshot.branches);
  const formatBranches = (
    branches: typeof localBranches,
    start: number,
    icon: string,
  ) =>
    branches
      .slice(start, start + branchLimit)
      .map(
        (branch) =>
          `${branchPresenceIcon(branchPresenceFromIndex(branch, presenceIndex), branch.current)} ${icon} ${displayBranchName(branch.name)}`,
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
      .flatMap((stash) => [
        ` ◇ ${stash.subject}`,
        `   on ${stash.branch ?? "unknown branch"} • ${stash.createdAt}`,
      ])
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
