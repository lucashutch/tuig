import { useCallback, useEffect, useRef, useState } from "react";
import type { GuigApi } from "../../shared/ipc.js";
import type { RepositorySnapshot } from "../../shared/types.js";

declare global {
  // Matches the preload's `window.guig` declaration; at runtime the key is
  // absent when running under `vite dev` in a plain browser.
  interface Window {
    guig: GuigApi;
  }
}

function backend(): GuigApi | undefined {
  if (typeof window !== "undefined" && window.guig) return window.guig;
  return undefined;
}

export function isBackendConnected(): boolean {
  return backend() !== undefined;
}

/** Deterministic mock so `npm run dev` renders a useful shell in a browser. */
function mockSnapshot(): RepositorySnapshot {
  return {
    root: "/mock/my-project",
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
    files: [
      {
        path: "src/app.ts",
        state: "modified",
        staged: false,
        unstaged: true,
      },
      {
        path: "README.md",
        state: "added",
        staged: true,
        unstaged: false,
      },
    ],
    branches: [
      {
        name: "main",
        fullName: "refs/heads/main",
        sha: "abc1234",
        current: true,
        remote: false,
      },
      {
        name: "feature/sidebar",
        fullName: "refs/heads/feature/sidebar",
        sha: "def5678",
        current: false,
        remote: false,
      },
      {
        name: "origin/main",
        fullName: "refs/remotes/origin/main",
        sha: "abc1234",
        current: false,
        remote: true,
      },
      {
        name: "origin/old-branch",
        fullName: "refs/remotes/origin/old-branch",
        sha: "9990000",
        current: false,
        remote: true,
      },
    ],
    stashes: [
      {
        ref: "stash@{0}",
        sha: "aaa111",
        createdAt: "2 hours ago",
        subject: "WIP on main: sidebar draft",
        branch: "main",
      },
    ],
    worktrees: [
      {
        path: "/mock/my-project",
        sha: "abc1234",
        branch: "main",
        bare: false,
        detached: false,
      },
      {
        path: "/mock/my-project-hotfix",
        sha: "def5678",
        branch: "hotfix",
        bare: false,
        detached: false,
        prunable: "prunable",
      },
    ],
    submodules: [
      {
        name: "vendor/lib",
        path: "vendor/lib",
        sha: "1234567",
        state: "clean",
      },
    ],
    commits: [],
    commitsComplete: true,
  };
}

async function loadSnapshot(repoPath?: string): Promise<RepositorySnapshot> {
  const api = backend();
  if (!api) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return mockSnapshot();
  }
  if (repoPath) await api.openRepo(repoPath).catch(() => undefined);
  return api.snapshot(250);
}

export interface SnapshotState {
  snapshot: RepositorySnapshot | undefined;
  loading: boolean;
  error: string | undefined;
  lastSyncedAt: number | undefined;
  refresh: () => Promise<void>;
}

const REFRESH_INTERVAL_MS = 10_000;

export function useSnapshot(repoPath: string | undefined): SnapshotState {
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | undefined>(
    undefined,
  );
  const repoRef = useRef(repoPath);
  repoRef.current = repoPath;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadSnapshot(repoRef.current || undefined);
      setSnapshot(next);
      setLastSyncedAt(Date.now());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh, repoPath]);

  return { snapshot, loading, error, lastSyncedAt, refresh };
}

async function runAction(
  action: (api: GuigApi) => Promise<void>,
  refresh: () => Promise<void>,
): Promise<void> {
  const api = backend();
  if (!api) {
    await refresh();
    return;
  }
  await action(api);
  await refresh();
}

export function fetchRemote(refresh: () => Promise<void>): Promise<void> {
  return runAction((api) => api.fetch(), refresh);
}

export function pullRemote(refresh: () => Promise<void>): Promise<void> {
  return runAction((api) => api.pull(), refresh);
}

export function pushRemote(refresh: () => Promise<void>): Promise<void> {
  return runAction((api) => api.push(), refresh);
}

export function stashChanges(refresh: () => Promise<void>): Promise<void> {
  return runAction((api) => api.stash(), refresh);
}

export function popStash(
  ref: string,
  refresh: () => Promise<void>,
): Promise<void> {
  return runAction((api) => api.popStash(ref), refresh);
}
