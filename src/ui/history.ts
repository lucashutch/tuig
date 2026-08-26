import type { BranchRef, Commit } from "../git/types.js";

export type BranchPresence = "local" | "remote" | "both" | "none";

export const HEAD_ICON = "◉";

export const LAPTOP_BRANCH_ICON = "󰌢";
export const REMOTE_BRANCH_ICON = "󰖟";

/**
 * Resolve the commit HEAD points at.
 *
 * A checked-out branch is authoritative; a detached HEAD has no current branch,
 * so it is recovered from the bare `HEAD` decoration git puts on the commit.
 */
export function resolveHeadSha(
  branches: readonly BranchRef[],
  commits: readonly Commit[],
): string | undefined {
  const current = branches.find((branch) => branch.current);
  if (current) return current.sha;
  return commits.find((commit) =>
    commit.decorations.some(
      (label) => label === "HEAD" || label.startsWith("HEAD -> "),
    ),
  )?.sha;
}

/** Return the abbreviated object name used in history rows. */
export function shortSha(sha: string, length = 8): string {
  return sha.slice(0, length);
}

export function displayBranchName(name: string): string {
  return name
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
}

/** Determine whether a branch name is represented locally, remotely, or both. */
export function branchPresence(
  nameOrRef: string | BranchRef,
  refs: readonly BranchRef[],
): BranchPresence {
  const rawName = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
  const name =
    typeof nameOrRef !== "string" && nameOrRef.remote
      ? rawName.replace(/^[^/]+\//, "")
      : rawName;
  const local = refs.some(
    (ref) =>
      !ref.remote &&
      (ref.name === name || ref.fullName === `refs/heads/${name}`),
  );
  const remote = refs.some(
    (ref) => ref.remote && (ref.name === name || ref.name.endsWith(`/${name}`)),
  );
  return local && remote
    ? "both"
    : local
      ? "local"
      : remote
        ? "remote"
        : "none";
}

export function branchPresenceIcon(
  presence: BranchPresence,
  current: boolean,
): string {
  // Keep the checked-out marker distinct from a branch that merely happens
  // to have a local and a remote ref.
  if (current) return HEAD_ICON;
  return presence === "both" ? "◆" : presence === "remote" ? "◌" : "○";
}

/**
 * Format a branch decoration for the history graph.
 *
 * Decorations use short names (for example `main` and `origin/main`), while
 * refs contain the authoritative local/remote and checked-out information.
 * Unknown decorations are left readable, rather than being mistaken for a
 * local branch. Tags are intentionally not handled here.
 */
export function formatBranchDecoration(
  label: string,
  refs: readonly BranchRef[],
): string {
  const head = label.startsWith("HEAD -> ") || label === "HEAD";
  const name = label.replace(/^HEAD -> /, "");
  const ref = refs.find(
    (candidate) =>
      candidate.name === name ||
      candidate.fullName === name ||
      candidate.fullName === `refs/heads/${name}` ||
      candidate.fullName === `refs/remotes/${name}`,
  );
  const displayName = displayBranchName(name);
  if (!ref) return head ? `${HEAD_ICON} ${displayName}` : displayName;
  const presence = branchPresence(ref, refs);
  // The checked-out ref takes the HEAD marker in place of the local icon: it
  // is necessarily local, and the column has no room for both.
  const local = head ? HEAD_ICON : LAPTOP_BRANCH_ICON;
  const icons =
    presence === "both"
      ? `${local} ${REMOTE_BRANCH_ICON}`
      : ref.remote
        ? REMOTE_BRANCH_ICON
        : local;
  return `${icons} ${displayName}`;
}

/** Branch context for commits that are ancestors rather than branch tips. */
export function buildCommitBranchHints(
  commits: readonly Commit[],
  refs: readonly BranchRef[],
): Map<string, string> {
  const commitsBySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const best = new Map<
    string,
    { distance: number; priority: number; ref: BranchRef }
  >();
  for (const ref of refs) {
    const queue: Array<{ sha: string; distance: number }> = [
      { sha: ref.sha, distance: 0 },
    ];
    const seen = new Set<string>();
    for (let at = 0; at < queue.length; at++) {
      const item = queue[at]!;
      if (seen.has(item.sha)) continue;
      seen.add(item.sha);
      const priority = ref.current ? 0 : ref.remote ? 2 : 1;
      const previous = best.get(item.sha);
      if (
        !previous ||
        item.distance < previous.distance ||
        (item.distance === previous.distance && priority < previous.priority)
      )
        best.set(item.sha, { distance: item.distance, priority, ref });
      const commit = commitsBySha.get(item.sha);
      for (const parent of commit?.parents ?? [])
        queue.push({ sha: parent, distance: item.distance + 1 });
    }
  }
  return new Map(
    [...best].map(([sha, value]) => [
      sha,
      `↳ ${value.ref.remote ? REMOTE_BRANCH_ICON : LAPTOP_BRANCH_ICON} ${displayBranchName(value.ref.name)}`,
    ]),
  );
}

export const TAG_ICON = "";

/**
 * Summarise every decoration on a commit.
 *
 * The history row has space for one label, so the primary ref is formatted in
 * full and the remainder is reported as a count instead of being dropped.
 * Tags are included, with their own glyph, because a release tag is often the
 * most useful thing about a commit.
 */
export function summariseDecorations(
  decorations: readonly string[],
  refs: readonly BranchRef[],
): { label: string; extra: number } {
  const tags = [
    ...new Set(
      decorations
        .filter((label) => label.startsWith("tag: "))
        .map((label) => label.slice(5)),
    ),
  ];
  const branches = decorations.filter((label) => !label.startsWith("tag: "));
  const head = branches.find((label) => label.startsWith("HEAD -> "));
  const ordered = [
    ...(head ? [head] : []),
    ...branches.filter((label) => label !== head),
  ];
  // A branch present locally and remotely is one branch: the label already
  // carries both icons, so counting it twice would invent a hidden ref.
  const distinct = new Set(
    ordered.map((label) => displayBranchName(label.replace(/^HEAD -> /, ""))),
  );
  const total = distinct.size + tags.length;
  if (total === 0) return { label: "", extra: 0 };
  const label = ordered[0]
    ? formatBranchDecoration(ordered[0], refs)
    : `${TAG_ICON} ${tags[0]}`;
  return { label, extra: total - 1 };
}

/**
 * Resolve the ref behind the label a history row shows.
 *
 * The row prints one decoration, so this returns the ref that decoration names,
 * keeping a remote ref remote: checking out a remote label has to go through
 * the local counterpart, and only the caller knows whether that is safe.
 */
export function primaryDecorationRef(
  decorations: readonly string[],
  refs: readonly BranchRef[],
): BranchRef | undefined {
  const branches = decorations.filter((label) => !label.startsWith("tag: "));
  const head = branches.find((label) => label.startsWith("HEAD -> "));
  const ordered = [
    ...(head ? [head] : []),
    ...branches.filter((label) => label !== head),
  ];
  const first = ordered[0];
  if (!first) return undefined;
  const name = first.replace(/^HEAD -> /, "");
  if (name === "HEAD") return undefined;
  return refs.find(
    (ref) =>
      ref.name === name ||
      ref.fullName === name ||
      ref.fullName === `refs/heads/${name}` ||
      ref.fullName === `refs/remotes/${name}`,
  );
}
