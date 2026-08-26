import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  layoutPreferencesPath,
  parseLayoutPreferences,
} from "../../src/ui/preferences.js";

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
      leftWidth: 31,
      detailsWidth: 52,
      unstagedHeight: 0,
      composerHeight: undefined,
    });
    expect(parseLayoutPreferences("invalid")).toEqual({});
  });
});
