import { describe, expect, test } from "bun:test";
import { GitCommandAbortedError, runGit } from "../../src/git/repository.js";
import {
  cancelActiveMutation,
  commit,
  perform,
  runMenuAction,
  type RuntimeCommandsContext,
} from "../../src/ui/runtime-commands.js";
import type { GraphMenuItem } from "../../src/ui/graph-menu.js";
import type {
  BranchRef,
  ChangedFile,
  GitRepository,
  RepositorySnapshot,
} from "../../src/git/types.js";
import type { RuntimePopupController } from "../../src/ui/runtime-popup.js";

type StubContext = RuntimeCommandsContext & {
  notifications: Array<{ text: string; tone?: string }>;
};

function stubContext(
  overrides: Partial<RuntimeCommandsContext> = {},
): StubContext {
  const notifications: Array<{ text: string; tone?: string }> = [];
  const context = {
    notifications,
    notify(text: string, tone?: "info" | "error" | "busy") {
      notifications.push({ text, tone });
    },
    fail(error: unknown) {
      notifications.push({ text: String(error), tone: "error" });
    },
    async refresh() {},
    ...overrides,
  };
  return context as unknown as StubContext;
}

describe("mutation runner", () => {
  test("branch deletion confirms the scope and preserves local on remote failure", async () => {
    const local: BranchRef = {
      name: "topic",
      fullName: "refs/heads/topic",
      sha: "a",
      current: false,
      remote: false,
      upstream: "origin/topic",
    };
    const remote: BranchRef = {
      name: "origin/topic",
      fullName: "refs/remotes/origin/topic",
      sha: "b",
      current: false,
      remote: true,
    };
    for (const scope of ["local", "remote", "both", "failed-both"] as const) {
      const calls: string[] = [];
      let confirm: (() => void) | undefined;
      let settled!: () => void;
      const done = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const context = stubContext({
        snapshot: { branches: [local, remote] } as RepositorySnapshot,
        repository: {
          async deleteBranch(name: string) {
            calls.push(`local:${name}`);
          },
          async deleteRemoteBranch(name: string) {
            calls.push(`remote:${name}`);
            if (scope === "failed-both") throw new Error("rejected");
          },
        } as unknown as GitRepository,
        popupController: {
          open(
            _title: string,
            items: GraphMenuItem[],
            _x: number,
            _y: number,
            select: (item: GraphMenuItem) => void,
          ) {
            confirm = () => select(items.find((item) => item.destructive)!);
          },
        } as unknown as RuntimePopupController,
        async refresh() {
          settled();
        },
        fail() {
          settled();
        },
      });
      await runMenuAction(
        context,
        `delete-branch-${scope === "failed-both" ? "both" : scope}`,
        { sha: local.sha, branch: local },
      );
      expect(calls).toEqual([]);
      expect(confirm).toBeDefined();
      confirm!();
      await done;
      expect(calls).toEqual(
        scope === "local"
          ? ["local:topic"]
          : scope === "both"
            ? ["remote:origin/topic", "local:topic"]
            : ["remote:origin/topic"],
      );
    }
  });
  test("branch deletion offers to remove its linked worktree and defaults to both", async () => {
    const calls: string[] = [];
    let items: GraphMenuItem[] = [];
    let select: ((item: GraphMenuItem) => void) | undefined;
    let selectedRow: number | undefined;
    const branch: BranchRef = {
      name: "topic",
      fullName: "refs/heads/topic",
      sha: "a",
      current: false,
      remote: false,
    };
    const context = stubContext({
      terminalWidth: 80,
      terminalHeight: 24,
      snapshot: {
        root: "/repo",
        branches: [branch],
        worktrees: [
          {
            path: "/worktrees/topic",
            sha: "a",
            branch: "topic",
            bare: false,
            detached: false,
          },
        ],
      } as RepositorySnapshot,
      repository: {
        async removeWorktree(path: string) {
          calls.push(`worktree:${path}`);
        },
        async deleteBranch(name: string) {
          calls.push(`branch:${name}`);
        },
      } as unknown as GitRepository,
      popupController: {
        open(
          _title: string,
          popupItems: GraphMenuItem[],
          _x: number,
          _y: number,
          callback: (item: GraphMenuItem) => void,
          _prompt: boolean,
          initialRow: number,
        ) {
          items = popupItems;
          select = callback;
          selectedRow = initialRow;
        },
      } as unknown as RuntimePopupController,
    });

    await runMenuAction(context, "delete-branch", {
      sha: branch.sha,
      branch,
    });

    expect(selectedRow).toBe(3);
    expect(items[selectedRow!]?.label).toBe("Delete branch and topic");
    select!(items[selectedRow!]!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["worktree:/worktrees/topic", "branch:topic"]);
  });
  test("refuses a second mutation while one is running", async () => {
    const context = stubContext();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void perform(context, "Pushing…", () => gate);
    await Promise.resolve();
    await perform(context, "Fetching…", async () => undefined, true);
    release?.();
    expect(
      context.notifications.some((n) => n.text === "Pushing… is still running"),
    ).toBe(true);
  });

  test("clears the busy state when a mutation settles", async () => {
    const context = stubContext();
    await perform(context, "Staging…", async () => undefined);
    expect(context.busy).toBeUndefined();
    await perform(context, "Staging again…", async () => undefined);
    expect(
      context.notifications.some((n) => n.text.includes("still running")),
    ).toBe(false);
  });

  test("holds the mutation lock until a commit and its refresh finish", async () => {
    let releaseCommit!: () => void;
    let releaseRefresh!: () => void;
    const commitGate = new Promise<void>(
      (resolve) => (releaseCommit = resolve),
    );
    const refreshGate = new Promise<void>(
      (resolve) => (releaseRefresh = resolve),
    );
    const context = stubContext({
      repository: {
        commit: () => commitGate,
      } as unknown as GitRepository,
      composerSummary: {
        value: "subject",
        blur() {},
      } as RuntimeCommandsContext["composerSummary"],
      composerBody: {
        plainText: "",
        blur() {},
        setText() {},
      } as unknown as RuntimeCommandsContext["composerBody"],
      files: (section) =>
        section === "staged"
          ? ([{ path: "file.ts" }] as unknown as ChangedFile[])
          : [],
      async refresh() {
        await refreshGate;
      },
      paintComposer() {},
    });
    const running = commit(context);
    await Promise.resolve();
    expect(context.busy).toBe("Committing");
    releaseCommit();
    await Promise.resolve();
    expect(context.busy).toBe("Committing");
    releaseRefresh();
    await running;
    expect(context.busy).toBeUndefined();
  });

  test("aborts a cancellable remote mutation and reports it", async () => {
    const context = stubContext();
    const run = perform(
      context,
      "Fetching…",
      async (signal) => {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new GitCommandAbortedError(["fetch"])),
          );
        });
      },
      true,
    );
    await Promise.resolve();
    expect(cancelActiveMutation(context)).toBe(true);
    await run;
    expect(
      context.notifications.some((n) => n.text.startsWith("Cancelled")),
    ).toBe(true);
    expect(context.busy).toBeUndefined();
  });

  test("reports false when there is nothing to cancel", () => {
    expect(cancelActiveMutation(stubContext())).toBe(false);
  });
});

describe("non-interactive git", () => {
  test("aborts an already-cancelled command", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGit(["log", "-1"], process.cwd(), undefined, controller.signal),
    ).rejects.toMatchObject({ name: "GitCommandAbortedError" });
  });

  test("runs a short command to completion", async () => {
    const result = await runGit(["--version"], process.cwd());
    expect(result.exitCode).toBe(0);
  });
});
