import { describe, expect, test } from "bun:test";

/**
 * The sandboxed preload cannot value-import `guig/shared/ipc.ts`, so
 * `guig/electron/preload.cts` carries a copy of the channel map. This test
 * fails when the two drift apart.
 */
describe("guig IPC channel sync", () => {
  test("preload channel strings match shared/ipc.ts", async () => {
    const root = new URL("..", import.meta.url).pathname;
    const shared = await Bun.file(`${root}guig/shared/ipc.ts`).text();
    const preload = await Bun.file(`${root}guig/electron/preload.cts`).text();
    const channels = (source: string): string[] =>
      [...source.matchAll(/"(guig:[a-z-]+)"/g)]
        .map((match) => match[1]!)
        .sort();
    expect(channels(preload)).toEqual(channels(shared));
  });
});
