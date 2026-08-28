import { describe, expect, test } from "bun:test";
import type { RepositorySnapshot, WorkingStatus } from "../../src/git/types.js";
import {
  refresh,
  refreshWorkingStatus,
  snapshotSignature,
  type RuntimeDataContext,
} from "../../src/ui/runtime-data.js";

function snapshot(
  overrides: Partial<RepositorySnapshot> = {},
): RepositorySnapshot {
  return {
    root: "/repo",
    branch: "main",
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

type Stub = RuntimeDataContext & { paints: number; snapshotReads: number };

function stubContext(
  initial: RepositorySnapshot | undefined,
  reader: {
    snapshot?: () => Promise<RepositorySnapshot>;
    workingStatus?: () => Promise<WorkingStatus>;
  },
): Stub {
  const context = {
    paints: 0,
    snapshotReads: 0,
    repository: {
      root: "/repo",
      async snapshot() {
        context.snapshotReads++;
        return reader.snapshot?.() ?? snapshot();
      },
      workingStatus: reader.workingStatus,
    },
    widgets: { commitDiff: { visible: false } },
    snapshot: initial,
    snapshotSignature: initial ? snapshotSignature(initial) : undefined,
    snapshotRequest: 0,
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
