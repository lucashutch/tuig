import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseSessionPreferences,
  sessionPreferencesPath,
} from "../../src/ui/session-preferences.js";

describe("session preferences", () => {
  test("uses the XDG config directory", () => {
    expect(sessionPreferencesPath({ XDG_CONFIG_HOME: "/config" })).toBe(
      join("/config", "tuig", "session.json"),
    );
  });

  test("keeps unique repository paths and a valid active repository", () => {
    expect(
      parseSessionPreferences({
        repositories: ["/one", "/two", "/one", 3],
        activeRepository: "/two",
      }),
    ).toEqual({ repositories: ["/one", "/two"], activeRepository: "/two" });
    expect(
      parseSessionPreferences({
        repositories: ["/one"],
        activeRepository: "/missing",
      }),
    ).toEqual({ repositories: ["/one"] });
  });
});
