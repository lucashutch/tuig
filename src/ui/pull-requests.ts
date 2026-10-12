// Pull request presentation: icons, sidebar grouping, and branch matching.
import type {
  CheckRollup,
  PullRequest,
  PullRequestList,
  PullRequestState,
} from "../git/pull-request-types.js";
import type { BranchRef, Commit } from "../git/types.js";
import { decorationRefIndexFor } from "./history.js";
import type { Theme } from "./theme.js";

/** Nerd Font octicon git-pull-request. */
export const PULL_REQUEST_OPEN_ICON = "";
/** Nerd Font octicon git-pull-request-draft. */
export const PULL_REQUEST_DRAFT_ICON = "";
/** Nerd Font octicon eye, marking pull requests that ask for your review. */
export const PULL_REQUEST_REVIEW_ICON = "";
/** First braille spinner frame, shown for running checks until it animates. */
const FIRST_SPINNER_FRAME = "⠋";

/** Check states that can still change, so the list is re-read sooner. */
export const UNSETTLED_CHECKS: ReadonlySet<CheckRollup> = new Set([
  "running",
  "pending",
  "tentative",
]);

export interface PullRequestGlyph {
  glyph: string;
  color: string;
}

/**
 * Icons and colors for one pull request. Every glyph is one cell wide.
 *
 * Tentative checks use the passed glyph in a dimmer success color, because
 * they have passed so far but some checks have not started.
 */
export function pullRequestIcons(
  pullRequest: { state: PullRequestState; checks: CheckRollup },
  theme: Theme,
  spinnerFrame = FIRST_SPINNER_FRAME,
): { state: PullRequestGlyph; checks: PullRequestGlyph } {
  const state =
    pullRequest.state === "draft"
      ? { glyph: PULL_REQUEST_DRAFT_ICON, color: theme.muted }
      : { glyph: PULL_REQUEST_OPEN_ICON, color: theme.added };
  const checks: Record<CheckRollup, PullRequestGlyph> = {
    failed: { glyph: "✗", color: theme.deleted },
    running: { glyph: spinnerFrame, color: theme.warning },
    tentative: { glyph: "✓", color: mixColor(theme.added, theme.bg, 0.5) },
    passed: { glyph: "✓", color: theme.added },
    pending: { glyph: "…", color: theme.muted },
    none: { glyph: "·", color: theme.muted },
  };
  return { state, checks: checks[pullRequest.checks] };
}

/** Blend two `#RRGGBB` colors. Other color forms return `color` unchanged. */
export function mixColor(color: string, toward: string, amount: number) {
  const parse = (value: string) =>
    /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)
      ? [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16))
      : undefined;
  const from = parse(color);
  const to = parse(toward);
  if (!from || !to) return color;
  return `#${from
    .map((channel, index) =>
      Math.round(channel + (to[index]! - channel) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
}

/** Highest number first. GitHub numbers pull requests in creation order. */
function newestFirst(a: PullRequest, b: PullRequest) {
  return b.number - a.number;
}

/**
 * Pull requests for the sidebar: yours first, then those that ask for your
 * review, each newest first. A pull request in both groups is listed once,
 * with yours.
 */
export function sidebarPullRequests(
  pullRequests: readonly PullRequest[],
): PullRequest[] {
  const mine = pullRequests.filter((pr) => pr.mine).sort(newestFirst);
  const reviews = pullRequests
    .filter((pr) => pr.reviewRequested && !pr.mine)
    .sort(newestFirst);
  return [...mine, ...reviews];
}

/** What the sidebar's pull request section shows. */
export type PullRequestPanel =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "message"; text: string }
  | { kind: "list"; pullRequests: readonly PullRequest[] };

/**
 * The section is hidden when the feature is off, and when `gh` is missing,
 * signed out, or the repository is not on GitHub. Other failures show their
 * message so the reader knows why the list is empty.
 */
export function pullRequestPanel(
  enabled: boolean,
  result: PullRequestList | undefined,
): PullRequestPanel {
  if (!enabled) return { kind: "hidden" };
  if (!result) return { kind: "loading" };
  if (result.available)
    return {
      kind: "list",
      pullRequests: sidebarPullRequests(result.pullRequests),
    };
  if (result.reason !== "error") return { kind: "hidden" };
  return {
    kind: "message",
    text: result.message ?? "Could not load pull requests",
  };
}

/** Rows the panel takes in the sidebar. */
export function pullRequestPanelRows(panel: PullRequestPanel): number {
  if (panel.kind === "hidden") return 0;
  if (panel.kind === "list") return panel.pullRequests.length;
  return 1;
}

/** Branch name of a remote-tracking ref without its remote, or undefined. */
function remoteBranchName(ref: BranchRef): string | undefined {
  const slash = ref.name.indexOf("/");
  return slash < 0 ? undefined : ref.name.slice(slash + 1);
}

/** The name a ref's pull request head would have, local or remote. */
function headBranchOf(ref: BranchRef): string | undefined {
  return ref.remote ? remoteBranchName(ref) : ref.name;
}

/**
 * The branch of this repository that holds a pull request's head.
 *
 * A local branch of the same name wins, then `origin`, then any other remote.
 * A fork's branch lives in another repository, so it never matches by name.
 */
export function pullRequestBranch(
  pullRequest: PullRequest,
  branches: readonly BranchRef[],
): BranchRef | undefined {
  if (pullRequest.fromFork) return undefined;
  const head = pullRequest.headBranch;
  return (
    branches.find((ref) => !ref.remote && ref.name === head) ??
    branches.find((ref) => ref.remote && ref.name === `origin/${head}`) ??
    branches.find((ref) => ref.remote && remoteBranchName(ref) === head)
  );
}

/** Finds the open pull requests for a history row. */
export interface PullRequestCommitIndex {
  /** Matching pull requests, newest first. */
  forCommit(commit: Pick<Commit, "sha" | "decorations">): PullRequest[];
}

/**
 * Match pull requests to history rows. A row matches when one of its branch
 * labels names a pull request's head branch, local or remote, or when the row
 * is the pull request's head commit. Fork pull requests match by commit only.
 */
export function pullRequestCommitIndex(
  pullRequests: readonly PullRequest[],
  branches: readonly BranchRef[],
): PullRequestCommitIndex {
  const byBranch = new Map<string, PullRequest[]>();
  const bySha = new Map<string, PullRequest[]>();
  const add = (map: Map<string, PullRequest[]>, key: string, pr: PullRequest) =>
    map.set(key, [...(map.get(key) ?? []), pr]);
  for (const pr of pullRequests) {
    if (!pr.fromFork) add(byBranch, pr.headBranch, pr);
    if (pr.headSha) add(bySha, pr.headSha, pr);
  }
  const refs = decorationRefIndexFor(branches);
  return {
    forCommit(commit) {
      const found = new Set(bySha.get(commit.sha));
      if (byBranch.size)
        for (const label of commit.decorations) {
          if (label.startsWith("tag: ")) continue;
          const ref = refs.get(label.replace(/^HEAD -> /, ""));
          const head = ref && headBranchOf(ref);
          for (const pr of (head && byBranch.get(head)) || []) found.add(pr);
        }
      return [...found].sort(newestFirst);
    },
  };
}

export interface StyledSegment {
  text: string;
  color: string;
}

/** Fit segments to exactly `width` cells, clipping the last with an ellipsis. */
export function fitSegments(
  segments: readonly StyledSegment[],
  width: number,
  padColor: string,
): StyledSegment[] {
  const result: StyledSegment[] = [];
  let used = 0;
  const total = segments.reduce(
    (sum, segment) => sum + Bun.stringWidth(segment.text),
    0,
  );
  const clip = total > width;
  const room = clip ? Math.max(0, width - 1) : width;
  for (const segment of segments) {
    if (used >= room) break;
    let text = "";
    for (const character of segment.text) {
      const next = Bun.stringWidth(character);
      if (used + next > room) break;
      text += character;
      used += next;
    }
    if (text) result.push({ text, color: segment.color });
    if (text !== segment.text) break;
  }
  if (clip && width > 0) {
    result.push({ text: "…", color: padColor });
    used++;
  }
  if (used < width)
    result.push({ text: " ".repeat(width - used), color: padColor });
  return result;
}

/** One sidebar row: state, checks, number, an optional review marker, title. */
export function pullRequestSidebarRow(
  pullRequest: PullRequest,
  width: number,
  theme: Theme,
  spinnerFrame?: string,
): StyledSegment[] {
  const icons = pullRequestIcons(pullRequest, theme, spinnerFrame);
  const review = pullRequest.reviewRequested && !pullRequest.mine;
  return fitSegments(
    [
      { text: " ", color: theme.text },
      { text: icons.state.glyph, color: icons.state.color },
      { text: " ", color: theme.text },
      { text: icons.checks.glyph, color: icons.checks.color },
      { text: ` #${pullRequest.number}`, color: theme.accent },
      ...(review
        ? [{ text: ` ${PULL_REQUEST_REVIEW_ICON}`, color: theme.muted }]
        : []),
      { text: ` ${pullRequest.title}`, color: theme.text },
    ],
    width,
    theme.text,
  );
}

/**
 * The history PR cell: number tinted by state, the checks icon, and `+N` when
 * more pull requests match the row. Empty rows return blank padding.
 */
export function pullRequestHistoryCell(
  pullRequests: readonly PullRequest[],
  width: number,
  theme: Theme,
  spinnerFrame?: string,
): StyledSegment[] {
  const [newest] = pullRequests;
  if (!newest) return fitSegments([], width, theme.muted);
  const icons = pullRequestIcons(newest, theme, spinnerFrame);
  return fitSegments(
    [
      { text: `#${newest.number}`, color: icons.state.color },
      { text: ` ${icons.checks.glyph}`, color: icons.checks.color },
      ...(pullRequests.length > 1
        ? [{ text: ` +${pullRequests.length - 1}`, color: theme.muted }]
        : []),
    ],
    width,
    theme.muted,
  );
}
