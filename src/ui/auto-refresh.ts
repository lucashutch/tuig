import {
  watchRepository,
  type RepositoryWatcher,
} from "../git/repository-watcher.js";
import type { GitRepository } from "../git/types.js";

/** Poll interval when the repository cannot be watched. */
export const FALLBACK_REFRESH_INTERVAL_MS = 10_000;
/** Safety-net poll while watching works, for events the watcher missed. */
export const WATCHED_REFRESH_INTERVAL_MS = 30_000;

export interface AutoRefreshScheduler {
  schedule(callback: () => void, intervalMs: number): unknown;
  cancel(handle: unknown): void;
}

/**
 * Start watching one repository. It throws when watching cannot start and
 * calls `onError` when a running watch fails.
 */
export type RepositoryWatcherFactory = (
  repository: GitRepository,
  onChange: (changedAt: number) => boolean,
  onError: (error: Error) => void,
) => Promise<RepositoryWatcher>;

const defaultScheduler: AutoRefreshScheduler = {
  schedule: (callback, intervalMs) => setInterval(callback, intervalMs),
  cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export const watchGitRepository: RepositoryWatcherFactory = async (
  repository,
  onChange,
  onError,
) => {
  if (!repository.watchPaths)
    throw new Error("This repository cannot be watched");
  return watchRepository(await repository.watchPaths(), onChange, onError);
};

/**
 * Keeps one repository fresh: a filesystem watch for fast updates, plus a
 * poll. The poll runs at the fallback interval until the watch is running,
 * and again if the watch fails, so a broken watch never stops refreshes.
 */
export function createAutoRefresh(options: {
  /** Periodic refresh. */
  poll: () => void;
  /** Watched change. Return false to be asked again later. */
  changed: (changedAt: number) => boolean;
  /** Reports why watching is unavailable and polling took over. */
  fallback?: (error: unknown) => void;
  watch?: RepositoryWatcherFactory;
  scheduler?: AutoRefreshScheduler;
}) {
  const watch = options.watch ?? watchGitRepository;
  const scheduler = options.scheduler ?? defaultScheduler;
  let watcher: RepositoryWatcher | undefined;
  let pollHandle: unknown;
  // Bumped on every follow and on dispose, so a watch that finishes starting
  // after the repository changed is closed instead of kept.
  let generation = 0;
  let disposed = false;

  const poll = (intervalMs: number) => {
    if (pollHandle !== undefined) scheduler.cancel(pollHandle);
    pollHandle = scheduler.schedule(options.poll, intervalMs);
  };
  const stopWatching = () => {
    watcher?.close();
    watcher = undefined;
  };

  return {
    /** Watch this repository instead of the previous one. */
    async follow(repository: GitRepository) {
      if (disposed) return;
      const current = ++generation;
      stopWatching();
      poll(FALLBACK_REFRESH_INTERVAL_MS);
      let next: RepositoryWatcher;
      try {
        next = await watch(
          repository,
          (changedAt) =>
            current === generation ? options.changed(changedAt) : true,
          (error) => {
            if (current !== generation) return;
            stopWatching();
            poll(FALLBACK_REFRESH_INTERVAL_MS);
            options.fallback?.(error);
          },
        );
      } catch (error) {
        if (current === generation) options.fallback?.(error);
        return;
      }
      if (current !== generation) return next.close();
      watcher = next;
      poll(WATCHED_REFRESH_INTERVAL_MS);
    },
    dispose() {
      disposed = true;
      generation++;
      stopWatching();
      if (pollHandle !== undefined) scheduler.cancel(pollHandle);
      pollHandle = undefined;
    },
  };
}
