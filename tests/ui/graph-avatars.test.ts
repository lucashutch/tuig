import { describe, expect, test } from "bun:test";
import type { Commit } from "../../src/git/types.js";
import {
  cancelGraphAvatars,
  updateGraphAvatars,
  type GraphAvatarRequest,
  type RuntimeDataContext,
} from "../../src/ui/runtime-data.js";

type FakeWidget = {
  visible: boolean;
  source?: unknown;
  left: number;
  top: number;
};

function commit(sha: string): Commit {
  return {
    sha,
    author: "Ada",
    // An unusable email keeps the loader off the network in tests.
    authorEmail: "",
    subject: "work",
    body: "",
    date: "",
    parents: [],
    decorations: [],
  } as unknown as Commit;
}

function context(avatarSupported = false) {
  const widgets: FakeWidget[] = [];
  const ctx = {
    repository: { remoteUrl: () => Promise.resolve(undefined) },
    widgets: {
      graphAvatars: widgets,
      ensureGraphAvatarSlots: (count: number) => {
        while (widgets.length < count)
          widgets.push({ visible: false, source: undefined, left: 0, top: 0 });
      },
    },
    avatarSupported,
    graphAvatarKeys: [] as Array<string | undefined>,
    graphAvatarTokens: [] as number[],
    graphAvatarAborts: [] as Array<AbortController | undefined>,
  } as unknown as RuntimeDataContext;
  return { ctx, widgets };
}

function request(slot: number, sha: string): GraphAvatarRequest {
  return {
    slot,
    commit: commit(sha),
    color: "#4b9cd3",
    background: "#282c34",
    left: 10,
    top: slot + 1,
    continuesAbove: true,
    continuesBelow: true,
  };
}

describe("graph avatar slots", () => {
  test("grows the pool to the deepest visible row", () => {
    const { ctx, widgets } = context();
    updateGraphAvatars(ctx, [request(0, "a"), request(3, "b")]);
    expect(widgets.length).toBe(4);
    expect(widgets[3]!.top).toBe(4);
  });

  test("keeps a slot's token while the same commit stays on screen", () => {
    const { ctx } = context();
    updateGraphAvatars(ctx, [request(0, "a")]);
    const token = ctx.graphAvatarTokens[0];
    updateGraphAvatars(ctx, [request(0, "a")]);
    // Repainting without a scroll must not re-download anything.
    expect(ctx.graphAvatarTokens[0]).toBe(token!);
  });

  test("bumps the token and aborts the load when a slot changes commit", () => {
    const { ctx } = context(true);
    updateGraphAvatars(ctx, [request(0, "a")]);
    const abort = ctx.graphAvatarAborts[0];
    const token = ctx.graphAvatarTokens[0]!;
    expect(abort?.signal.aborted).toBe(false);
    updateGraphAvatars(ctx, [request(0, "b")]);
    expect(abort?.signal.aborted).toBe(true);
    expect(ctx.graphAvatarTokens[0]!).toBeGreaterThan(token);
  });

  test("a lane color change reprocesses the same commit", () => {
    const { ctx } = context(true);
    updateGraphAvatars(ctx, [request(0, "a")]);
    const first = ctx.graphAvatarKeys[0];
    const moved = { ...request(0, "a"), color: "#c678dd" };
    updateGraphAvatars(ctx, [moved]);
    expect(ctx.graphAvatarKeys[0]).not.toBe(first!);
  });

  test("clears and aborts slots that scroll out of view", () => {
    const { ctx, widgets } = context(true);
    updateGraphAvatars(ctx, [request(0, "a"), request(1, "b")]);
    const abort = ctx.graphAvatarAborts[1];
    updateGraphAvatars(ctx, [request(0, "a")]);
    expect(ctx.graphAvatarKeys[1]).toBeUndefined();
    expect(widgets[1]!.visible).toBe(false);
    expect(widgets[1]!.source).toBeUndefined();
    expect(abort?.signal.aborted).toBe(true);
  });

  test("an empty request list hides every slot", () => {
    const { ctx, widgets } = context();
    updateGraphAvatars(ctx, [request(0, "a"), request(1, "b")]);
    updateGraphAvatars(ctx, []);
    expect(widgets.every((widget) => !widget.visible)).toBe(true);
    expect(ctx.graphAvatarKeys.every((key) => key === undefined)).toBe(true);
  });

  test("retries a slot when image protocol detection becomes available", () => {
    const { ctx, widgets } = context(false);
    updateGraphAvatars(ctx, [request(0, "a")]);
    expect(ctx.graphAvatarKeys[0]).toBeUndefined();
    ctx.avatarSupported = true;
    updateGraphAvatars(ctx, [request(0, "a")]);
    expect(ctx.graphAvatarKeys[0]).toBeDefined();
    expect(widgets[0]!.visible).toBe(true);
  });

  test("cancelGraphAvatars aborts every in-flight load", () => {
    const { ctx } = context(true);
    updateGraphAvatars(ctx, [request(0, "a"), request(1, "b")]);
    const aborts = [ctx.graphAvatarAborts[0], ctx.graphAvatarAborts[1]];
    cancelGraphAvatars(ctx);
    expect(aborts.every((abort) => abort?.signal.aborted)).toBe(true);
  });
});
