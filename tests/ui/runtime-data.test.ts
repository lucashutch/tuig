import { describe, expect, test } from "bun:test";
import type {
  DiffRequest,
  RepositorySnapshot,
  WorkingStatus,
} from "../../src/git/types.js";
import { GitOutputLimitError } from "../../src/git/repository.js";
import {
  DIFF_DISPLAY_MAX_BYTES,
  DIFF_HIGHLIGHT_MAX_BYTES,
} from "../../src/ui/diff-policy.js";
import type { Commit, CommitPage } from "../../src/git/types.js";
import {
  HISTORY_PAGE,
  cancelDiff,
  loadDiff,
  loadMoreCommits,
  refresh,
  refreshWorkingStatus,
  snapshotSignature,
  type RuntimeDataContext,
} from "../../src/ui/runtime-data.js";
import { layoutGraph } from "../../src/ui/graph.js";
import {
  emptyGraphIndex,
  extendGraphIndex,
  graphWindow,
} from "../../src/ui/graph-index.js";
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
    refreshSnapshot?: (
      previous: RepositorySnapshot,
      limit?: number,
    ) => Promise<RepositorySnapshot>;
    commitPage?: (limit: number, skip?: number) => Promise<CommitPage>;
  },
): Stub {
  const graphIndex = emptyGraphIndex();
  extendGraphIndex(graphIndex, initial?.commits ?? [], oneDarkTheme.graph);
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
      refreshSnapshot: reader.refreshSnapshot,
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
    graphIndex,
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
  test("incrementally appended history matches a fresh fingerprint", () => {
    const initial = snapshot({ commitsComplete: false });
    const before = snapshotSignature(initial);
    initial.commits.push({
      ...initial.commits[0]!,
      sha: "b".repeat(40),
      decorations: [],
    });
    expect(snapshotSignature(initial)).not.toBe(before);
    expect(snapshotSignature(initial)).toBe(
      snapshotSignature({ ...initial, commits: [...initial.commits] }),
    );
    expect(snapshotSignature({ ...initial, commitsComplete: true })).not.toBe(
      snapshotSignature(initial),
    );
  });
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
  test("automatic metadata refresh preserves the graph for working-tree changes", async () => {
    const initial = snapshot();
    const context = stubContext(initial, {
      refreshSnapshot: async (previous) => ({
        ...previous,
        files: [
          { path: "a.txt", state: "modified", staged: false, unstaged: true },
        ],
      }),
    });
    const graph = context.graphIndex;
    const hints = context.branchHintIndex;
    await refresh(context, undefined, true);
    expect(context.snapshotReads).toBe(0);
    expect(context.snapshot?.commits).toBe(initial.commits);
    expect(context.graphIndex).toBe(graph);
    expect(context.branchHintIndex).toBe(hints);
    expect(context.paints).toBe(1);
  });

  test("manual refresh bypasses history reuse and busy polls do not queue work", async () => {
    const context = stubContext(snapshot(), {
      refreshSnapshot: async () => {
        throw new Error("manual refresh used poll path");
      },
    });
    await refresh(context);
    expect(context.snapshotReads).toBe(1);
    context.busy = true;
    await refresh(context, undefined, true);
    expect(context.refreshPending).toBe(false);
    await refresh(context);
    expect(context.refreshPending).toBe(true);
  });
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

function diffContext(read: (request: DiffRequest) => Promise<string>) {
  const context = stubContext(
    snapshot({
      files: [
        { path: "a.ts", state: "modified", staged: false, unstaged: true },
        { path: "b.ts", state: "modified", staged: false, unstaged: true },
      ],
    }),
    {},
  );
  const display = {
    visible: true,
    diff: "previous diff",
    filetype: undefined as string | undefined,
    wrapMode: "word" as "word" | "none",
    clear() {
      this.diff = "";
      this.filetype = undefined;
    },
    setDiff(
      value: string,
      filetype?: string,
      wrapMode: "word" | "none" = "word",
    ) {
      this.diff = value;
      this.filetype = filetype;
      this.wrapMode = wrapMode;
    },
  };
  context.widgets.commitDiff =
    display as unknown as RuntimeDataContext["widgets"]["commitDiff"];
  context.widgets.commitDiffEmpty = {
    content: "",
    visible: false,
  } as unknown as RuntimeDataContext["widgets"]["commitDiffEmpty"];
  context.repository.diff = read;
  context.view = "working";
  context.mode = "unstaged";
  return { context, display };
}

describe("diff resource policy", () => {
  test("working-status changes cancel the old read and reload the visible diff", async () => {
    let resolveOld!: (value: string) => void;
    const { context, display } = diffContext(async (request) =>
      request.path === "a.ts"
        ? new Promise<string>((resolve) => {
            resolveOld = resolve;
          })
        : "remaining file diff",
    );
    const old = loadDiff(context);
    const notifications: string[] = [];
    context.notify = (text, tone) => {
      if (tone === "busy") notifications.push(text);
    };
    const signal = context.diffAbort?.signal;
    context.repository.workingStatus = async () => ({
      ahead: 0,
      behind: 0,
      files: [
        { path: "b.ts", state: "modified", staged: false, unstaged: true },
      ],
    });
    await refreshWorkingStatus(context);
    expect(notifications).toEqual([]);
    expect(signal?.aborted).toBe(true);
    resolveOld("stale diff");
    await old;
    expect(display.diff).toBe("remaining file diff");
  });

  test("sends display bounds and highlights small file diffs", async () => {
    let request: DiffRequest | undefined;
    const { context, display } = diffContext(async (value) => {
      request = value;
      return "small diff";
    });
    await loadDiff(context);
    expect(request?.maxBytes).toBe(DIFF_DISPLAY_MAX_BYTES);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(display.diff).toBe("small diff");
    expect(display.filetype).toBe("typescript");
    expect(context.diffAbort).toBeUndefined();
  });

  test("large diffs bypass both highlighting and wrapping", async () => {
    const { context, display } = diffContext(async () =>
      "a".repeat(DIFF_HIGHLIGHT_MAX_BYTES),
    );
    await loadDiff(context);
    expect(display.filetype).toBeUndefined();
    expect(display.wrapMode).toBe("none");
  });

  test("overflow offers a one-selection override without highlighting", async () => {
    const limits: Array<number | undefined> = [];
    const { context, display } = diffContext(async ({ maxBytes }) => {
      limits.push(maxBytes);
      if (maxBytes) throw new GitOutputLimitError([], maxBytes);
      return "full diff";
    });
    await loadDiff(context);
    expect(context.diffTooLarge).toBe(true);
    expect(display.diff).toBe("");
    expect(context.widgets.commitDiffEmpty.content.toString()).toContain(
      "Shift+L",
    );
    await loadDiff(context, true);
    expect(limits).toEqual([DIFF_DISPLAY_MAX_BYTES, undefined]);
    expect(display.diff).toBe("full diff");
    expect(display.filetype).toBeUndefined();
    expect(context.diffTooLarge).toBe(false);
    context.fileIndex = 1;
    await loadDiff(context);
    expect(limits[2]).toBe(DIFF_DISPLAY_MAX_BYTES);
  });

  test("aborts the previous selection and ignores its late result", async () => {
    let firstSignal: AbortSignal | undefined;
    let resolveFirst!: (value: string) => void;
    const { context, display } = diffContext(async (request) => {
      if (request.path === "b.ts") return "second diff";
      firstSignal = request.signal;
      return new Promise<string>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const first = loadDiff(context);
    expect(display.diff).toBe("");
    context.fileIndex = 1;
    await loadDiff(context);
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst("obsolete diff");
    await first;
    expect(display.diff).toBe("second diff");
  });

  test("cancelling a pending diff suppresses its error", async () => {
    let reject!: (reason: Error) => void;
    const { context, display } = diffContext(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const read = loadDiff(context);
    const signal = context.diffAbort?.signal;
    cancelDiff(context);
    reject(new Error("process cancelled"));
    await read;
    expect(signal?.aborted).toBe(true);
    expect(display.diff).toBe("");
  });

  test("does not read a hidden diff in history view", async () => {
    const { context, display } = diffContext(async () => {
      throw new Error("unexpected read");
    });
    context.view = "history";
    await loadDiff(context);
    expect(display.diff).toBe("");
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
    const before = context.graphIndex.length;
    await loadMoreCommits(context);
    // The boundary commit is re-read so the two walks can be compared.
    expect(context.pageRequests).toEqual([[251, 249]]);
    expect(context.snapshot?.commits).toHaveLength(500);
    expect(context.snapshot?.commitsComplete).toBe(false);
    expect(context.graphIndex.length).toBe(before + 250);
    expect(context.historyPaints).toBe(1);
    // Replaying the extended index must match a layout of the whole list, so
    // resuming the fold cannot drift from a full refresh.
    expect(
      graphWindow(
        context.graphIndex,
        context.snapshot!.commits,
        oneDarkTheme.graph,
        0,
        500,
      ),
    ).toEqual(layoutGraph(all.slice(0, 500), oneDarkTheme.graph));
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
