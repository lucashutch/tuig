import { describe, expect, test } from "bun:test";
import type { RepositorySnapshot, WorkingStatus } from "../../src/git/types.js";
import type { Commit, CommitPage } from "../../src/git/types.js";
import {
  HISTORY_PAGE,
  loadMoreCommits,
  refresh,
  refreshWorkingStatus,
  snapshotSignature,
  type RuntimeDataContext,
} from "../../src/ui/runtime-data.js";
import { layoutGraph, layoutGraphFrom } from "../../src/ui/graph.js";
import { emptyBranchHintIndex } from "../../src/ui/history.js";
import { oneDarkTheme } from "../../src/ui/theme.js";

function snapshot(
  overrides: Partial<RepositorySnapshot> = {},
): RepositorySnapshot {
  return {
    root: "/repo",
    branch: "main",
    commitsComplete: true,
    ahead: 0,
    behind: 0,
    files: [],
    branches: [
      {
        name: "main",
        fullName: "refs/heads/main",
        sha: "a".repeat(40),
        current: true,
        remote: false,
      },
    ],
    stashes: [],
    worktrees: [],
    submodules: [],
    commits: [
      {
        sha: "a".repeat(40),
        parents: [],
        author: "Test User",
        authorEmail: "test@example.com",
        authoredAt: "2020-01-01T00:00:00+00:00",
        committer: "Test User",
        committerEmail: "test@example.com",
        committedAt: "2020-01-01T00:00:00+00:00",
        subject: "initial",
        decorations: ["HEAD -> main"],
      },
    ],
    ...overrides,
  };
}

type Stub = RuntimeDataContext & {
  paints: number;
  snapshotReads: number;
  historyPaints: number;
  pageRequests: Array<[number, number]>;
};

function stubContext(
  initial: RepositorySnapshot | undefined,
  reader: {
    snapshot?: (limit?: number) => Promise<RepositorySnapshot>;
    workingStatus?: () => Promise<WorkingStatus>;
    commitPage?: (limit: number, skip?: number) => Promise<CommitPage>;
  },
): Stub {
  const laidOut = layoutGraphFrom(initial?.commits ?? [], oneDarkTheme.graph);
  const context = {
    paints: 0,
    snapshotReads: 0,
    historyPaints: 0,
    pageRequests: [] as Array<[number, number]>,
    repository: {
      root: "/repo",
      async snapshot(limit?: number) {
        context.snapshotReads++;
        return reader.snapshot?.(limit) ?? snapshot();
      },
      workingStatus: reader.workingStatus,
      commitPage: reader.commitPage
        ? (limit: number, skip = 0) => {
            context.pageRequests.push([limit, skip]);
            return reader.commitPage!(limit, skip);
          }
        : undefined,
    },
    widgets: { commitDiff: { visible: false } },
    snapshot: initial,
    snapshotSignature: initial ? snapshotSignature(initial) : undefined,
    snapshotRequest: 0,
    historyLimit: HISTORY_PAGE,
    loadingMoreCommits: false,
    historyPageFailures: 0,
    graphRows: laidOut.rows,
    graphLayoutState: laidOut.state,
    graphColumns: 1,
    branchHints: new Map<string, string>(),
    branchHintIndex: emptyBranchHintIndex(),
    diffRequest: 0,
    commitFilesRequest: 0,
    busy: false,
    refreshPending: false,
    view: "history",
    commitIndex: 0,
    fileIndex: 0,
    files: () => context.snapshot?.files ?? [],
    selectedFile: () => context.snapshot?.files[context.fileIndex],
    ensureFileVisible() {},
    layout() {},
    paint() {
      context.paints++;
    },
    paintFiles() {},
    paintHistory() {
      context.historyPaints++;
    },
    paintHints() {},
    notify() {},
    fail(error: unknown) {
      throw error;
    },
    async refresh() {},
  };
  return context as unknown as Stub;
}

describe("snapshot fingerprint", () => {
  test("ignores fields that cannot change without a new object name", () => {
    const before = snapshot();
    const after = snapshot({
      commits: [{ ...snapshot().commits[0]!, body: "a later read" }],
    });
    expect(snapshotSignature(after)).toBe(snapshotSignature(before));
  });

  test("notices a staged file, a moved branch, and a new commit", () => {
    const base = snapshotSignature(snapshot());
    expect(
      snapshotSignature(
        snapshot({
          files: [
            { path: "a.txt", state: "modified", staged: true, unstaged: false },
          ],
        }),
      ),
    ).not.toBe(base);
    expect(
      snapshotSignature(
        snapshot({
          branches: [
            {
              name: "main",
              fullName: "refs/heads/main",
              sha: "b".repeat(40),
              current: true,
              remote: false,
            },
          ],
        }),
      ),
    ).not.toBe(base);
    expect(snapshotSignature(snapshot({ commits: [] }))).not.toBe(base);
  });
});

describe("refresh", () => {
  test("keeps the snapshot object and skips the repaint when nothing changed", async () => {
    const initial = snapshot();
    const context = stubContext(initial, { snapshot: async () => snapshot() });
    await refresh(context);
    expect(context.paints).toBe(0);
    expect(context.snapshot).toBe(initial);
    // An unchanged refresh must not invalidate an open diff.
    expect(context.diffRequest).toBe(0);
  });

  test("repaints when the snapshot changed", async () => {
    const context = stubContext(snapshot(), {
      snapshot: async () =>
        snapshot({
          files: [
            {
              path: "a.txt",
              state: "modified",
              staged: false,
              unstaged: true,
            },
          ],
        }),
    });
    await refresh(context);
    expect(context.paints).toBe(1);
  });
});

describe("working-status refresh", () => {
  test("applies new files without re-reading history", async () => {
    const context = stubContext(snapshot(), {
      workingStatus: async () => ({
        ahead: 0,
        behind: 0,
        files: [
          { path: "a.txt", state: "modified", staged: false, unstaged: true },
        ],
      }),
    });
    await refreshWorkingStatus(context);
    expect(context.snapshotReads).toBe(0);
    expect(context.paints).toBe(1);
    expect(context.snapshot?.files).toHaveLength(1);
    expect(context.snapshot?.commits).toHaveLength(1);
  });

  test("skips the repaint when the working tree is unchanged", async () => {
    const context = stubContext(snapshot(), {
      workingStatus: async () => ({ ahead: 0, behind: 0, files: [] }),
    });
    await refreshWorkingStatus(context);
    expect(context.paints).toBe(0);
  });

  test("falls back to a full refresh without the fast path", async () => {
    const context = stubContext(snapshot(), {
      snapshot: async () => snapshot({ ahead: 3 }),
    });
    await refreshWorkingStatus(context);
    expect(context.snapshotReads).toBe(1);
    expect(context.snapshot?.ahead).toBe(3);
  });
});

function commit(sha: string, parent?: string): Commit {
  return {
    sha,
    parents: parent ? [parent] : [],
    author: "Test User",
    authorEmail: "test@example.com",
    authoredAt: "2020-01-01T00:00:00+00:00",
    committer: "Test User",
    committerEmail: "test@example.com",
    committedAt: "2020-01-01T00:00:00+00:00",
    subject: sha,
    decorations: [],
  };
}

/** A linear history, newest first, as Git reports it. */
function history(length: number): Commit[] {
  return Array.from({ length }, (_, index) =>
    commit(`c${index}`, index + 1 < length ? `c${index + 1}` : undefined),
  );
}

/** Serve pages the way the repository does, honouring skip. */
function pager(all: Commit[]) {
  return async (limit: number, skip = 0): Promise<CommitPage> => {
    const slice = all.slice(skip, skip + limit + 1);
    const complete = slice.length <= limit;
    return { commits: complete ? slice : slice.slice(0, limit), complete };
  };
}

describe("paged history", () => {
  test("appends the next page and keeps the earlier rows", async () => {
    const all = history(600);
    const loaded = snapshot({
      commits: all.slice(0, 250),
      commitsComplete: false,
    });
    const context = stubContext(loaded, { commitPage: pager(all) });
    const before = context.graphRows.length;
    await loadMoreCommits(context);
    // The boundary commit is re-read so the two walks can be compared.
    expect(context.pageRequests).toEqual([[251, 249]]);
    expect(context.snapshot?.commits).toHaveLength(500);
    expect(context.snapshot?.commitsComplete).toBe(false);
    expect(context.graphRows).toHaveLength(before + 250);
    expect(context.historyPaints).toBe(1);
    // The appended rows must match a layout of the whole list, so resuming
    // the fold cannot drift from a full refresh.
    expect(context.graphRows).toEqual(
      layoutGraph(all.slice(0, 500), oneDarkTheme.graph),
    );
  });

  test("marks history complete on the last page", async () => {
    const all = history(300);
    const context = stubContext(
      snapshot({ commits: all.slice(0, 250), commitsComplete: false }),
      { commitPage: pager(all) },
    );
    await loadMoreCommits(context);
    expect(context.snapshot?.commits).toHaveLength(300);
    expect(context.snapshot?.commitsComplete).toBe(true);
  });

  test("does nothing once every commit is loaded", async () => {
    const context = stubContext(snapshot({ commitsComplete: true }), {
      commitPage: async () => ({ commits: [], complete: true }),
    });
    await loadMoreCommits(context);
    expect(context.pageRequests).toEqual([]);
    expect(context.historyPaints).toBe(0);
  });

  test("loads one page at a time", async () => {
    const all = history(1000);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = stubContext(
      snapshot({ commits: all.slice(0, 250), commitsComplete: false }),
      {
        commitPage: async (limit, skip) => {
          await gate;
          return pager(all)(limit, skip);
        },
      },
    );
    const first = loadMoreCommits(context);
    await loadMoreCommits(context);
    release?.();
    await first;
    expect(context.pageRequests).toEqual([[251, 249]]);
  });

  test("refreshes instead of appending when the walk no longer lines up", async () => {
    const all = history(600);
    const moved = [commit("new-tip", "c0"), ...all];
    let refreshes = 0;
    const context = stubContext(
      snapshot({ commits: all.slice(0, 250), commitsComplete: false }),
      { commitPage: pager(moved) },
    );
    context.refresh = async () => {
      refreshes++;
    };
    await loadMoreCommits(context);
    // Divergence means the refs the page would be laid out against are stale
    // too, so the whole snapshot is re-read rather than patched here.
    expect(refreshes).toBe(1);
    expect(context.historyLimit).toBe(500);
    expect(context.snapshot?.commits).toHaveLength(250);
    expect(context.historyPaints).toBe(0);
  });

  test("treats an amended boundary commit as divergence", async () => {
    const all = history(600);
    // Same sha at the boundary, different parents: an amend above it would
    // otherwise slip past a sha-only check.
    const amended = all.map((entry, index) =>
      index === 249 ? { ...entry, parents: ["rewritten"] } : entry,
    );
    let refreshes = 0;
    const context = stubContext(
      snapshot({ commits: all.slice(0, 250), commitsComplete: false }),
      { commitPage: pager(amended) },
    );
    context.refresh = async () => {
      refreshes++;
    };
    await loadMoreCommits(context);
    expect(refreshes).toBe(1);
  });

  test("stops asking for pages after repeated failures", async () => {
    const context = stubContext(
      snapshot({ commits: history(250), commitsComplete: false }),
      {
        commitPage: async () => {
          throw new Error("git exploded");
        },
      },
    );
    for (let attempt = 0; attempt < 5; attempt++)
      await loadMoreCommits(context);
    expect(context.pageRequests).toHaveLength(3);
  });

  test("discards a page that a refresh has already replaced", async () => {
    const all = history(600);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = stubContext(
      snapshot({ commits: all.slice(0, 250), commitsComplete: false }),
      {
        commitPage: async (limit, skip) => {
          await gate;
          return pager(all)(limit, skip);
        },
      },
    );
    const loading = loadMoreCommits(context);
    const replaced = snapshot({ commits: all.slice(0, 10) });
    context.snapshot = replaced;
    release?.();
    await loading;
    expect(context.snapshot).toBe(replaced);
    expect(context.historyPaints).toBe(0);
  });

  test("keeps a failed page from breaking the loaded history", async () => {
    const loaded = snapshot({ commits: history(250), commitsComplete: false });
    const context = stubContext(loaded, {
      commitPage: async () => {
        throw new Error("git exploded");
      },
    });
    await loadMoreCommits(context);
    expect(context.snapshot).toBe(loaded);
    expect(context.loadingMoreCommits).toBe(false);
  });
});

test("a refresh in flight does not throw away a page that landed under it", async () => {
  const all = history(600);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = snapshot({ commits: all.slice(0, 250), commitsComplete: false });
  const context = stubContext(base, {
    snapshot: async (limit = 250) => {
      // The first read is slow, so a page lands while it is outstanding.
      if (context.snapshotReads === 1) await gate;
      return snapshot({
        commits: all.slice(0, limit),
        commitsComplete: limit >= all.length,
      });
    },
    commitPage: pager(all),
  });
  const refreshing = refresh(context);
  await loadMoreCommits(context);
  expect(context.snapshot?.commits).toHaveLength(500);
  release?.();
  await refreshing;
  // The refresh must re-read at the deeper limit rather than replacing the
  // history with the 250 commits it originally asked for.
  expect(context.historyLimit).toBe(500);
  expect(context.snapshot?.commits).toHaveLength(500);
});
