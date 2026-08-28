import { describe, expect, test } from "bun:test";
import { GitCommandAbortedError, runGit } from "../../src/git/repository.js";
import {
  cancelActiveMutation,
  perform,
  type RuntimeCommandsContext,
} from "../../src/ui/runtime-commands.js";

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
