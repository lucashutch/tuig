import type { BranchRef, Commit } from "../git/types.js";

export type BranchPresence = "local" | "remote" | "both" | "none";

export const LAPTOP_BRANCH_ICON = "󰌢";
export const REMOTE_BRANCH_ICON = "󰖟";

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
  if (current) return "◉";
  return presence === "both" ? "◆" : presence === "remote" ? "◌" : "○";
}

/** Compact branch marker; checked-out branches use a distinct marker. */
export function branchIcon(ref: Pick<BranchRef, "current" | "remote">): string {
  if (ref.current) return "◉";
  return ref.remote ? "◌" : "○";
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
  const name = label.replace(/^HEAD -> /, "");
  const ref = refs.find(
    (candidate) =>
      candidate.name === name ||
      candidate.fullName === name ||
      candidate.fullName === `refs/heads/${name}` ||
      candidate.fullName === `refs/remotes/${name}`,
  );
  const displayName = displayBranchName(name);
  if (!ref) return displayName;
  const presence = branchPresence(ref, refs);
  const icons =
    presence === "both"
      ? `${LAPTOP_BRANCH_ICON} ${REMOTE_BRANCH_ICON}`
      : ref.remote
        ? REMOTE_BRANCH_ICON
        : LAPTOP_BRANCH_ICON;
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

export function formatHistoryCommit(commit: Commit): string {
  return `${shortSha(commit.sha)}  ${commit.subject}`;
}
