import { expect, test } from "bun:test";
import type { GitRepository } from "../../src/git/types.js";
import {
  createAutoRefresh,
  FALLBACK_REFRESH_INTERVAL_MS,
  WATCHED_REFRESH_INTERVAL_MS,
  type AutoRefreshScheduler,
  type RepositoryWatcherFactory,
} from "../../src/ui/auto-refresh.js";

function fakeScheduler() {
  const active = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const scheduler: AutoRefreshScheduler = {
    schedule: (callback, ms) => {
      active.set(++next, { callback, ms });
      return next;
    },
    cancel: (handle) => active.delete(handle as number),
  };
  return {
    scheduler,
    intervals: () => [...active.values()].map((entry) => entry.ms),
    tick: () => active.forEach((entry) => entry.callback()),
  };
}

const repository = (root: string) => ({ root }) as GitRepository;

test("polling takes over when the watch cannot start", async () => {
  const timers = fakeScheduler();
  let polls = 0;
  const fallbacks: unknown[] = [];
  const auto = createAutoRefresh({
    poll: () => polls++,
    changed: () => true,
    fallback: (error) => fallbacks.push(error),
    watch: async () => {
      throw Object.assign(new Error("inotify watch limit reached"), {
        code: "ENOSPC",
      });
    },
    scheduler: timers.scheduler,
  });

  await auto.follow(repository("/repo"));
  timers.tick();

  expect(timers.intervals()).toEqual([FALLBACK_REFRESH_INTERVAL_MS]);
  expect(polls).toBe(1);
  expect(fallbacks).toHaveLength(1);
});

test("a working watch slows the poll, and a failed one restores it", async () => {
  const timers = fakeScheduler();
  let fail: ((error: Error) => void) | undefined;
  let closed = 0;
  const auto = createAutoRefresh({
    poll: () => undefined,
    changed: () => true,
    watch: async (_repository, _onChange, onError) => {
      fail = onError;
      return { close: () => closed++ };
    },
    scheduler: timers.scheduler,
  });

  await auto.follow(repository("/repo"));
  expect(timers.intervals()).toEqual([WATCHED_REFRESH_INTERVAL_MS]);

  fail!(new Error("watched directory was removed"));
  expect(closed).toBe(1);
  expect(timers.intervals()).toEqual([FALLBACK_REFRESH_INTERVAL_MS]);
});

test("switching repositories and disposing close every watch", async () => {
  const timers = fakeScheduler();
  const open = new Set<string>();
  const changes: string[] = [];
  const notify = new Map<string, (changedAt: number) => boolean>();
  let releaseSlow: (() => void) | undefined;
  const watch: RepositoryWatcherFactory = async (repo, onChange) => {
    // The second repository is still starting when the third is chosen.
    if (repo.root === "/slow")
      await new Promise<void>((resolve) => (releaseSlow = resolve));
    open.add(repo.root);
    notify.set(repo.root, onChange);
    return { close: () => open.delete(repo.root) };
  };
  const auto = createAutoRefresh({
    poll: () => undefined,
    changed: () => {
      changes.push("changed");
      return true;
    },
    watch,
    scheduler: timers.scheduler,
  });

  await auto.follow(repository("/first"));
  const slow = auto.follow(repository("/slow"));
  expect(open).toEqual(new Set());
  await auto.follow(repository("/third"));
  releaseSlow!();
  await slow;
  expect(open).toEqual(new Set(["/third"]));

  // A late event from a replaced watch must not refresh the new repository.
  notify.get("/first")!(1);
  expect(changes).toEqual([]);
  notify.get("/third")!(2);
  expect(changes).toEqual(["changed"]);

  auto.dispose();
  expect(open).toEqual(new Set());
  expect(timers.intervals()).toEqual([]);
});
