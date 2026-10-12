import { watch } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { ownGitActive, runGit } from "./repository";
import type { RepositoryWatchPaths } from "./types";

/** Quiet time after the last event before a burst counts as one change. */
export const WATCH_DEBOUNCE_MS = 200;
/** A steady stream of events, such as a build, still reports once per window. */
export const WATCH_MAX_WAIT_MS = 1000;
/** Delay before asking again when the caller cannot refresh yet. */
export const WATCH_RETRY_MS = 1000;
/**
 * Index writes this soon after a Tuig Git process exits are its own. Watch
 * events and process exits reach the event loop in no fixed order.
 */
const OWN_INDEX_WRITE_GRACE_MS = 150;
/** Larger bursts skip the ignore check and always count as a change. */
const IGNORE_CHECK_LIMIT = 200;

export interface RepositoryWatcher {
  close(): void;
}

export interface RepositoryWatchOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  retryMs?: number;
}

type WatchEvent = "ignore" | "metadata" | "index" | "work-tree";

function inside(parent: string, path: string) {
  const offset = relative(parent, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

/**
 * Sort one changed path into the Git state it can affect.
 *
 * Only HEAD, the index, and refs change what Tuig shows. Objects, logs, and
 * lock files change on every commit and would only add noise. A `.git`
 * segment inside the work tree belongs to a nested repository or submodule.
 */
export function classifyWatchEvent(
  paths: RepositoryWatchPaths,
  path: string,
): WatchEvent {
  if (inside(paths.gitDir, path)) {
    const name = relative(paths.gitDir, path);
    if (name === "index") return "index";
    if (name === "HEAD") return "metadata";
  }
  if (inside(paths.commonDir, path)) {
    const name = relative(paths.commonDir, path);
    if (name.endsWith(".lock")) return "ignore";
    if (name === "packed-refs" || name.startsWith(`refs${sep}`))
      return "metadata";
    return "ignore";
  }
  if (inside(paths.gitDir, path)) return "ignore";
  if (inside(paths.workTree, path)) {
    const name = relative(paths.workTree, path);
    if (name === "" || name.split(sep).includes(".git")) return "ignore";
    return "work-tree";
  }
  return "ignore";
}

/**
 * Directories to watch. The work tree is watched recursively and already
 * covers a normal `.git` directory. A linked worktree or submodule keeps its
 * Git dir elsewhere, and refs can live in a shared common dir.
 */
function watchTargets(paths: RepositoryWatchPaths) {
  const targets = [{ path: paths.workTree, recursive: true }];
  if (!inside(paths.workTree, paths.gitDir))
    targets.push({ path: paths.gitDir, recursive: false });
  if (!inside(paths.workTree, paths.commonDir)) {
    if (paths.commonDir !== paths.gitDir)
      targets.push({ path: paths.commonDir, recursive: false });
    targets.push({ path: join(paths.commonDir, "refs"), recursive: true });
  }
  return targets;
}

/** True when Git ignores every one of the given work-tree paths. */
async function allIgnored(workTree: string, names: string[]) {
  try {
    // -z needs --stdin, which runGit does not feed. A name Git still quotes,
    // such as one with a newline, fails the match and counts as a change.
    const result = await runGit(
      ["-c", "core.quotePath=false", "check-ignore", "--", ...names],
      workTree,
    );
    const ignored = new Set(result.stdout.split("\n").filter(Boolean));
    return names.every((name) => ignored.has(name));
  } catch {
    // Exit code 1 means none of the paths is ignored. Other failures, such as
    // a path inside a submodule, count as a change.
    return false;
  }
}

/**
 * Report changes to a repository's HEAD, index, refs, and work tree.
 *
 * A burst of events is reported once, after it goes quiet. `onChange` gets
 * the time of the latest event in the burst and returns false when it cannot
 * refresh yet; the watcher then asks again later. Index writes made by Tuig's
 * own Git processes are dropped so a refresh cannot trigger another one.
 *
 * Throws when a watch cannot start, for example when the inotify watch limit
 * is reached. `onError` reports a watch that fails later; the watcher is
 * closed by then.
 */
export function watchRepository(
  paths: RepositoryWatchPaths,
  onChange: (changedAt: number) => boolean,
  onError: (error: Error) => void,
  options: RepositoryWatchOptions = {},
): RepositoryWatcher {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? WATCH_MAX_WAIT_MS;
  const retryMs = options.retryMs ?? WATCH_RETRY_MS;
  const watchers: Array<ReturnType<typeof watch>> = [];
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let burstStartedAt: number | undefined;
  let changedAt = 0;
  // Work-tree paths in the burst, checked against .gitignore before
  // reporting. Undefined once the burst holds a change that always counts.
  let workTreeNames: Set<string> | undefined = new Set();

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
  };
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), Math.max(0, delay));
  };
  const flush = async () => {
    timer = undefined;
    const names = workTreeNames;
    burstStartedAt = undefined;
    workTreeNames = new Set();
    if (names?.size && (await allIgnored(paths.workTree, [...names]))) return;
    if (closed) return;
    if (onChange(changedAt)) return;
    workTreeNames = undefined;
    burstStartedAt ??= performance.now();
    if (!timer) schedule(retryMs);
  };
  const event = (directory: string, filename: string | Buffer | null) => {
    if (closed) return;
    const kind = filename
      ? classifyWatchEvent(paths, join(directory, filename.toString()))
      : "metadata";
    if (kind === "ignore") return;
    if (kind === "index" && ownGitActive(OWN_INDEX_WRITE_GRACE_MS)) return;
    const now = performance.now();
    changedAt = now;
    if (kind !== "work-tree") workTreeNames = undefined;
    else if (workTreeNames) {
      workTreeNames.add(
        relative(paths.workTree, join(directory, filename!.toString())),
      );
      if (workTreeNames.size > IGNORE_CHECK_LIMIT) workTreeNames = undefined;
    }
    burstStartedAt ??= now;
    schedule(Math.min(debounceMs, burstStartedAt + maxWaitMs - now));
  };

  try {
    for (const target of watchTargets(paths)) {
      const watcher = watch(
        target.path,
        { recursive: target.recursive, persistent: false },
        (_kind, filename) => event(target.path, filename),
      );
      watchers.push(watcher);
      watcher.on("error", (error: Error) => {
        if (closed) return;
        close();
        onError(error);
      });
    }
  } catch (error) {
    close();
    throw error;
  }
  return { close };
}
