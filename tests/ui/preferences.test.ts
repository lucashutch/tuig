import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  layoutPreferencesPath,
  loadLayoutPreferences,
  parseLayoutPreferences,
  saveLayoutPreferences,
} from "../../src/ui/preferences.js";
import {
  clampDetailsWidth,
  clampSidebarWidth,
} from "../../src/ui/runtime-layout.js";

describe("layout preferences", () => {
  test("uses the XDG config directory", () => {
    expect(layoutPreferencesPath({ XDG_CONFIG_HOME: "/config" })).toBe(
      join("/config", "tuig", "layout.json"),
    );
  });

  test("keeps valid dimensions and ignores corrupt values", () => {
    expect(
      parseLayoutPreferences({
        leftWidth: 31,
        detailsWidth: 52,
        unstagedHeight: 0,
        composerHeight: -4,
      }),
    ).toEqual({
      remoteFetchIntervalMinutes: undefined,
      leftWidth: 31,
      detailsWidth: 52,
      unstagedHeight: 0,
      composerHeight: undefined,
    });
    expect(parseLayoutPreferences("invalid")).toEqual({});
  });

  test("reads the automatic remote fetch interval", () => {
    expect(parseLayoutPreferences({ remoteFetchIntervalMinutes: 15 })).toEqual({
      remoteFetchIntervalMinutes: 15,
      leftWidth: undefined,
      detailsWidth: undefined,
      unstagedHeight: undefined,
      composerHeight: undefined,
    });
    expect(parseLayoutPreferences({ remoteFetchIntervalMinutes: -1 })).toEqual({
      remoteFetchIntervalMinutes: undefined,
      leftWidth: undefined,
      detailsWidth: undefined,
      unstagedHeight: undefined,
      composerHeight: undefined,
    });
  });

  test("reads the avatar display preference", () => {
    expect(parseLayoutPreferences({ avatarsEnabled: false })).toMatchObject({
      avatarsEnabled: false,
    });
    expect(parseLayoutPreferences({ avatarsEnabled: "no" })).toMatchObject({
      avatarsEnabled: undefined,
    });
  });

  test("reads only supported diff view preferences", () => {
    expect(parseLayoutPreferences({ diffView: "side-by-side" })).toMatchObject({
      diffView: "side-by-side",
    });
    expect(parseLayoutPreferences({ diffView: "grid" })).toMatchObject({
      diffView: undefined,
    });
  });
});

describe("saved pane and column layout", () => {
  const directories: string[] = [];
  const temporaryPath = async () => {
    const directory = await mkdtemp(join(tmpdir(), "tuig-layout-"));
    directories.push(directory);
    return join(directory, "tuig", "layout.json");
  };
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  test("round trips panes, collapsed state, and history columns", async () => {
    const path = await temporaryPath();
    const saved = {
      leftWidth: 33,
      detailsWidth: 50,
      leftCollapsed: true,
      detailsCollapsed: false,
      historyColumns: {
        branchWidth: 18,
        graphWidth: 12,
        committerWidth: 9,
        showCommitter: false,
        showSha: true,
      },
      unstagedHeight: 7,
    };
    await saveLayoutPreferences(saved, path);
    expect(await loadLayoutPreferences(path)).toMatchObject(saved);
  });

  test("keeps unknown keys and the fetch interval when saving", async () => {
    const path = await temporaryPath();
    await saveLayoutPreferences({ leftWidth: 20 }, path);
    await writeFile(
      path,
      JSON.stringify({
        remoteFetchIntervalMinutes: 15,
        futureSetting: { a: 1 },
        leftWidth: 20,
      }),
    );
    await saveLayoutPreferences(
      { leftWidth: 40, detailsWidth: undefined },
      path,
    );
    const stored = await Bun.file(path).json();
    expect(stored).toEqual({
      remoteFetchIntervalMinutes: 15,
      futureSetting: { a: 1 },
      leftWidth: 40,
    });
    expect(await readdir(join(path, ".."))).toEqual(["layout.json"]);
  });

  test("replaces a malformed file and loads defaults from it", async () => {
    const path = await temporaryPath();
    await saveLayoutPreferences({}, path);
    await writeFile(path, "{ not json");
    expect(await loadLayoutPreferences(path)).toEqual({});
    await saveLayoutPreferences({ leftWidth: 30 }, path);
    expect(await loadLayoutPreferences(path)).toMatchObject({ leftWidth: 30 });
  });

  test("falls back per field for invalid history column values", () => {
    expect(
      parseLayoutPreferences({
        leftCollapsed: "yes",
        detailsCollapsed: true,
        historyColumns: {
          branchWidth: -3,
          graphWidth: 12.4,
          committerWidth: 1e9,
          showCommitter: "no",
          showSha: false,
        },
      }),
    ).toMatchObject({
      leftCollapsed: undefined,
      detailsCollapsed: true,
      historyColumns: {
        branchWidth: undefined,
        graphWidth: 12,
        committerWidth: undefined,
        showCommitter: undefined,
        showSha: false,
      },
    });
    expect(parseLayoutPreferences({ historyColumns: 5 }).historyColumns).toBe(
      undefined,
    );
  });

  test("clamps widths saved on a wide terminal to a narrow one", () => {
    expect(clampSidebarWidth(90, 100)).toBe(55);
    expect(clampSidebarWidth(90, 200)).toBe(90);
    expect(clampSidebarWidth(2, 100)).toBe(16);
    expect(clampDetailsWidth(120, 100)).toBe(65);
    expect(clampDetailsWidth(5, 100)).toBe(30);
  });
});
