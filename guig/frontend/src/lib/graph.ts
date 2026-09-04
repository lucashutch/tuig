// Pure lane assignment for the guig history graph.
// No DOM, no React. Unit-friendly: pure function of the commit list.

import type { BranchRef, Commit } from "../../../shared/types.js";

/** Default lane palette (One Dark inspired, colorblind-tolerant order). */
export const GRAPH_COLORS: readonly string[] = [
  "#61afef",
  "#98c379",
  "#e5c07b",
  "#c678dd",
  "#56b6c2",
  "#d19a66",
  "#ef596f",
];

/** One routed edge from this row toward the row below (parent). */
export interface GraphEdge {
  from: number;
  to: number;
  color: string;
}

/** Layout output for one commit row. */
export interface RowGraph {
  sha: string;
  lane: number;
  color: string;
  /** Number of lanes occupied on this row (width hint for the canvas). */
  laneCount: number;
  /** Per-lane colors for vertical strokes on this row. */
  columns: string[];
  /** Edges from this row's dot down to its parents' lanes. */
  edges: GraphEdge[];
  continuesAbove: boolean;
  head: boolean;
  /** Primary ref/tag label shown beside the dot. Empty when unlabelled. */
  label: string;
  /** Remaining ref/tag count shown as `+N`. */
  extra: number;
  /** Raw ref name behind the label (for checkout events). */
  refName?: string;
  remote: boolean;
  tag: boolean;
}

export interface AssignLanesOptions {
  refs?: readonly BranchRef[];
  headSha?: string;
  colors?: readonly string[];
}

function displayName(name: string): string {
  return name
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
}

interface ResolvedLabel {
  label: string;
  extra: number;
  refName?: string;
  remote: boolean;
  tag: boolean;
}

/** Resolve one visible label plus the `+N` overflow from decorations. */
export function resolveRowLabel(
  decorations: readonly string[],
  refs: readonly BranchRef[] = [],
): ResolvedLabel {
  const tags = [
    ...new Set(
      decorations
        .filter((label) => label.startsWith("tag: "))
        .map((label) => label.slice(5).trim())
        .filter(Boolean),
    ),
  ];
  const branches = decorations.filter((label) => !label.startsWith("tag: "));
  const head = branches.find((label) => label.startsWith("HEAD -> "));
  const ordered = [
    ...(head ? [head] : []),
    ...branches.filter((label) => label !== head),
  ];
  const distinct = new Set(
    ordered.map((label) => displayName(label.replace(/^HEAD -> /, "").trim())),
  );
  const total = distinct.size + tags.length;
  if (total === 0)
    return {
      label: "",
      extra: 0,
      refName: undefined,
      remote: false,
      tag: false,
    };
  const first = ordered[0];
  if (first) {
    const raw = first.replace(/^HEAD -> /, "").trim();
    const ref = refs.find(
      (candidate) =>
        candidate.name === raw ||
        candidate.fullName === raw ||
        candidate.fullName === `refs/heads/${raw}` ||
        candidate.fullName === `refs/remotes/${raw}`,
    );
    return {
      label: displayName(raw),
      extra: total - 1,
      refName: raw === "HEAD" ? undefined : raw,
      remote: ref ? ref.remote : raw.includes("/"),
      tag: false,
    };
  }
  const tag = tags[0] ?? "";
  return {
    label: tag,
    extra: total - 1,
    refName: undefined,
    remote: false,
    tag: true,
  };
}

/**
 * Assign persistent lanes in newest-first log order.
 * First parent keeps the lane color; extra parents open new lanes.
 */
export function assignLanes(
  commits: readonly Commit[],
  options: AssignLanesOptions = {},
): RowGraph[] {
  const colors =
    options.colors && options.colors.length > 0 ? options.colors : GRAPH_COLORS;
  const refs = options.refs ?? [];
  const active: string[] = [];
  const activeColors: string[] = [];
  let nextColor = 0;
  const color = (): string => colors[nextColor++ % colors.length] ?? "#888888";

  return commits.map((commit) => {
    let lane = active.indexOf(commit.sha);
    const continuesAbove = lane >= 0;
    if (lane < 0) {
      lane = active.length;
      active.push(commit.sha);
      activeColors.push(color());
    }
    const beforeColors = [...activeColors];
    const parents = commit.parents.filter(
      (parent, index, all) => Boolean(parent) && all.indexOf(parent) === index,
    );

    active.splice(lane, 1, ...parents);
    activeColors.splice(
      lane,
      1,
      ...parents.map((_, index) =>
        index === 0 ? (beforeColors[lane] ?? color()) : color(),
      ),
    );
    // A later duplicate of this sha is a fan-in: drop it so the dot joins.
    for (let index = active.length - 1; index > lane; index--) {
      if (active[index] === commit.sha) {
        active.splice(index, 1);
        activeColors.splice(index, 1);
      }
    }

    const laneCount = Math.max(active.length, lane + 1);
    const columns: string[] = [];
    for (let column = 0; column < laneCount; column++) {
      columns.push(
        column === lane
          ? (beforeColors[lane] ?? "#888888")
          : (beforeColors[column] ?? activeColors[column] ?? "#888888"),
      );
    }
    const edges: GraphEdge[] = parents.map((parent, index) => {
      const to = active.indexOf(parent);
      return {
        from: lane,
        to: to >= 0 ? to : lane + index,
        color:
          index === 0
            ? (beforeColors[lane] ?? "#888888")
            : (activeColors[lane + index] ?? "#888888"),
      };
    });

    const resolved = resolveRowLabel(commit.decorations, refs);
    const head =
      options.headSha !== undefined
        ? commit.sha === options.headSha
        : commit.decorations.some(
            (label) => label === "HEAD" || label.startsWith("HEAD -> "),
          );

    return {
      sha: commit.sha,
      lane,
      color: beforeColors[lane] ?? "#888888",
      laneCount,
      columns,
      edges,
      continuesAbove,
      head,
      label: resolved.label,
      extra: resolved.extra,
      refName: resolved.refName,
      remote: resolved.remote,
      tag: resolved.tag,
    };
  });
}
