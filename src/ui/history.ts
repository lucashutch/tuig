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

/**
 * A small, terminal-safe author avatar.  Initials are preferable to remote
 * avatar services here: history remains useful offline and renders the same
 * way in every terminal.
 */
export function authorInitials(author: string, email = ""): string {
  const source = author.trim() || email.split("@")[0]?.trim() || "?";
  const words = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials =
    words.length > 1
      ? `${words[0]![0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? "?");
  // Keep badges stable and safe even when a display name contains emoji or
  // combining marks unsupported by the terminal font.
  const safe = initials.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
  return (safe || "?").slice(0, 2).toUpperCase();
}

export function authorAvatar(author: string, email = ""): string {
  return `[${authorInitials(author, email)}]`;
}

/** Format a commit timestamp without depending on the machine's locale. */
export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown time";
  const seconds = Math.round((now - timestamp) / 1000);
  const future = seconds < 0;
  const amount = Math.abs(seconds);
  if (amount < 10) return future ? "in a moment" : "just now";
  const units: Array<[number, string]> = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [4, "w"],
    [12, "mo"],
    [Number.POSITIVE_INFINITY, "y"],
  ];
  let rest = amount;
  let unit = "s";
  for (const [size, name] of units) {
    unit = name;
    if (rest < size) break;
    rest = Math.floor(rest / size);
  }
  return future ? `in ${rest}${unit}` : `${rest}${unit} ago`;
}

/** Compact author treatment used by graph rows and commit metadata cards. */
export function formatCommitAuthor(
  author: string,
  email: string,
  authoredAt: string,
  now = Date.now(),
): string {
  return `${authorAvatar(author, email)} ${formatRelativeTime(authoredAt, now)}`;
}

/**
 * Build the predicate behind `filterBranchRefs`.
 *
 * Callers that already walk the refs use this to avoid materialising an
 * intermediate filtered array per paint.
 */
export function branchRefFilter(query: string): (ref: BranchRef) => boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return () => true;
  return (ref) =>
    [
      ref.name,
      ref.fullName,
      displayBranchName(ref.name),
      displayBranchName(ref.fullName),
    ].some((value) => value.toLocaleLowerCase().includes(needle));
}

/** Filter local or remote refs by a case-insensitive substring query. */
export function filterBranchRefs(
  refs: readonly BranchRef[],
  query: string,
): BranchRef[] {
  return refs.filter(branchRefFilter(query));
}

export type BranchSection = "local" | "remote";

/**
 * Return the rows shown by one of the branch sections in the sidebar.
 *
 * Keep the local and remote rows separate even when they point at the same
 * object.  They are different refs (and therefore different actions) in the
 * UI; filtering must not accidentally collapse a local branch and its
 * remote-tracking counterpart into one selectable row.
 */
export function branchRefsForSection(
  refs: readonly BranchRef[],
  section: BranchSection,
  query = "",
): BranchRef[] {
  return filterBranchRefs(
    refs.filter((ref) => (section === "remote" ? ref.remote : !ref.remote)),
    query,
  );
}

/**
 * Clamp a branch row index to the available rows.
 *
 * `-1` represents no selectable row, which is useful while a search has no
 * matches and mirrors Array#findIndex.  Selection does not wrap at either
 * end: pressing up on the first row or down on the last row is a no-op.
 */
export function clampBranchSelection(
  selection: number,
  rowCount: number,
): number {
  const count = Number.isFinite(rowCount)
    ? Math.max(0, Math.trunc(rowCount))
    : 0;
  if (count === 0) return -1;
  const index = Number.isFinite(selection) ? Math.trunc(selection) : 0;
  return Math.max(0, Math.min(count - 1, index));
}

/** Move a branch selection through filtered rows without wrapping. */
export function moveBranchSelection(
  refs: readonly BranchRef[],
  selection: number,
  delta: number,
  query = "",
): number {
  const filtered = filterBranchRefs(refs, query);
  const movement = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const current = Number.isFinite(selection) ? Math.trunc(selection) : 0;
  return clampBranchSelection(current + movement, filtered.length);
}

/** Resolve a possibly stale row index against the current filtered rows. */
export function selectedBranchRef(
  refs: readonly BranchRef[],
  selection: number,
  query = "",
): BranchRef | undefined {
  if (!Number.isFinite(selection) || selection < 0) return undefined;
  const filtered = filterBranchRefs(refs, query);
  const index = clampBranchSelection(selection, filtered.length);
  return index < 0 ? undefined : filtered[index];
}

export function displayBranchName(name: string): string {
  return name
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
}

/**
 * Constant-time lookup tables for `branchPresence`.
 *
 * Presence used to rescan every ref (and re-normalise its name) for each row,
 * which is quadratic on repositories with thousands of branches.  Building the
 * sets once per ref array keeps the sidebar paint linear.
 */
export type BranchPresenceIndex = {
  readonly localNames: ReadonlySet<string>;
  readonly remoteNames: ReadonlySet<string>;
  readonly remoteNameSuffixes: ReadonlySet<string>;
  readonly remotePrefixes: ReadonlySet<string>;
};

function stripRefPrefixes(name: string): string {
  return name.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
}

export function buildBranchPresenceIndex(
  refs: readonly BranchRef[],
): BranchPresenceIndex {
  const localNames = new Set<string>();
  const remoteNames = new Set<string>();
  const remoteNameSuffixes = new Set<string>();
  const remotePrefixes = new Set<string>();
  for (const ref of refs) {
    if (!ref.remote) {
      localNames.add(ref.name);
      localNames.add(ref.fullName);
      if (ref.fullName.startsWith("refs/heads/"))
        localNames.add(ref.fullName.slice("refs/heads/".length));
      continue;
    }
    const remoteName = stripRefPrefixes(ref.name);
    remoteNames.add(remoteName);
    // `endsWith("/" + name)` matches any suffix that starts after a slash.
    for (
      let slash = remoteName.indexOf("/");
      slash >= 0;
      slash = remoteName.indexOf("/", slash + 1)
    )
      remoteNameSuffixes.add(remoteName.slice(slash + 1));
    const separator = remoteName.indexOf("/");
    if (separator > 0) remotePrefixes.add(remoteName.slice(0, separator));
  }
  return { localNames, remoteNames, remoteNameSuffixes, remotePrefixes };
}

const presenceIndexCache = new WeakMap<object, BranchPresenceIndex>();

/**
 * The presence index for a ref array, built once and reused.
 *
 * Snapshots replace `branches` rather than mutating it, so an entry stays
 * valid for the life of the snapshot and repeated paints pay nothing.
 */
export function presenceIndexFor(
  refs: readonly BranchRef[],
): BranchPresenceIndex {
  const cached = presenceIndexCache.get(refs);
  if (cached) return cached;
  const index = buildBranchPresenceIndex(refs);
  presenceIndexCache.set(refs, index);
  return index;
}

/** Determine whether a branch name is represented locally, remotely, or both. */
export function branchPresence(
  nameOrRef: string | BranchRef,
  refs: readonly BranchRef[],
): BranchPresence {
  return branchPresenceFromIndex(nameOrRef, presenceIndexFor(refs));
}

/** `branchPresence` against a prebuilt index, for row loops. */
export function branchPresenceFromIndex(
  nameOrRef: string | BranchRef,
  index: BranchPresenceIndex,
): BranchPresence {
  const rawName = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
  const normalisedName = stripRefPrefixes(rawName);
  // A string can be either a short local name or a decorated remote name
  // (for example `origin/main`).  BranchRef already tells us which case it
  // is, so only strip a remote prefix for remote refs and string labels.
  const separator = normalisedName.indexOf("/");
  const remotePrefix =
    separator > 0 ? normalisedName.slice(0, separator) : undefined;
  const isKnownRemoteName =
    rawName.startsWith("refs/remotes/") ||
    (remotePrefix !== undefined && index.remotePrefixes.has(remotePrefix));
  const treatAsRemote =
    typeof nameOrRef === "string" ? isKnownRemoteName : nameOrRef.remote;
  const names =
    treatAsRemote && separator > 0
      ? [normalisedName, normalisedName.slice(separator + 1)]
      : [normalisedName];
  const local = names.some((name) => index.localNames.has(name));
  const remote = names.some(
    (name) => index.remoteNames.has(name) || index.remoteNameSuffixes.has(name),
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
  if (label === "refs/stash" || label === "stash") return "stash";
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
  const best = new Map<string, BranchRef>();
  // One multi-source walk, level by level, settles every commit at its
  // smallest hop distance and expands it once; walking per ref re-walks shared
  // history once per ref, which dominates on repositories with many refs.
  let frontier = new Map<
    string,
    { priority: number; order: number; ref: BranchRef }
  >();
  const consider = (
    into: Map<string, { priority: number; order: number; ref: BranchRef }>,
    sha: string,
    candidate: { priority: number; order: number; ref: BranchRef },
  ) => {
    if (best.has(sha)) return;
    const previous = into.get(sha);
    if (
      !previous ||
      candidate.priority < previous.priority ||
      (candidate.priority === previous.priority &&
        candidate.order < previous.order)
    )
      into.set(sha, candidate);
  };
  refs.forEach((ref, order) => {
    consider(frontier, ref.sha, {
      priority: ref.current ? 0 : ref.remote ? 2 : 1,
      order,
      ref,
    });
  });
  while (frontier.size > 0) {
    const next = new Map<
      string,
      { priority: number; order: number; ref: BranchRef }
    >();
    for (const [sha, candidate] of frontier) best.set(sha, candidate.ref);
    for (const [sha, candidate] of frontier) {
      const commit = commitsBySha.get(sha);
      for (const parent of commit?.parents ?? [])
        consider(next, parent, candidate);
    }
    frontier = next;
  }
  return new Map(
    [...best].map(([sha, ref]) => [
      sha,
      `↳ ${ref.remote ? REMOTE_BRANCH_ICON : LAPTOP_BRANCH_ICON} ${displayBranchName(ref.name)}`,
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
  if (name === "HEAD" || name === "refs/stash" || name === "stash")
    return undefined;
  return refs.find(
    (ref) =>
      ref.name === name ||
      ref.fullName === name ||
      ref.fullName === `refs/heads/${name}` ||
      ref.fullName === `refs/remotes/${name}`,
  );
}
