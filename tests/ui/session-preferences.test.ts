import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseSessionPreferences,
  promoteRecentRepository,
  removeRecentRepository,
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

  test("keeps valid submodule tab relationships", () => {
    expect(
      parseSessionPreferences({
        repositories: ["/parent", "/parent/sub"],
        submodules: {
          "/parent/sub": { root: "/parent", path: "sub" },
          "/missing": { root: "/parent", path: "missing" },
          "/parent": { root: 3, path: "bad" },
        },
      }),
    ).toEqual({
      repositories: ["/parent", "/parent/sub"],
      submodules: { "/parent/sub": { root: "/parent", path: "sub" } },
    });
  });

  test("keeps at most 20 unique nonempty recent paths in order", () => {
    const paths = Array.from({ length: 25 }, (_, index) => `/repo-${index}`);
    expect(
      parseSessionPreferences({
        repositories: [],
        recentRepositories: ["", paths[0], 42, ...paths],
      }).recentRepositories,
    ).toEqual(paths.slice(0, 20));
  });

  test("promotes a successful root and removes a stale root", () => {
    const paths = Array.from({ length: 20 }, (_, index) => `/repo-${index}`);
    expect(promoteRecentRepository(paths, "/repo-3")).toEqual([
      "/repo-3",
      ...paths.filter((path) => path !== "/repo-3"),
    ]);
    expect(promoteRecentRepository(paths, "/new")).toEqual([
      "/new",
      ...paths.slice(0, 19),
    ]);
    expect(removeRecentRepository(paths, "/repo-3")).toEqual(
      paths.filter((path) => path !== "/repo-3"),
    );
  });
});
