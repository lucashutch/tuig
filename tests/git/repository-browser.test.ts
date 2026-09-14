import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { suggestDirectories } from "../../src/git/repository-browser.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("directory suggestions", () => {
  test("lists sorted non-hidden child directories and ignores files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tuig-browser-"));
    cleanup.push(cwd);
    await Promise.all([
      mkdir(join(cwd, "zulu")),
      mkdir(join(cwd, "Alpha")),
      mkdir(join(cwd, ".cache")),
      writeFile(join(cwd, "notes.txt"), "not a directory"),
    ]);

    const suggestions = await suggestDirectories("", cwd);
    expect(suggestions).toEqual([
      { name: "Alpha", path: join(cwd, "Alpha") },
      { name: "zulu", path: join(cwd, "zulu") },
    ]);
  });

  test("filters the basename case-insensitively for relative and absolute paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tuig-browser-"));
    cleanup.push(cwd);
    await mkdir(join(cwd, "Projects"));
    await mkdir(join(cwd, "Profiles"));
    await mkdir(join(cwd, "Projects", "Nested"));

    expect(await suggestDirectories("pr", cwd)).toEqual([
      { name: "Profiles", path: join(cwd, "Profiles") },
      { name: "Projects", path: join(cwd, "Projects") },
    ]);
    expect(await suggestDirectories(join(cwd, "Projects", "nEs"), cwd)).toEqual(
      [{ name: "Nested", path: join(cwd, "Projects", "Nested") }],
    );
  });

  test("uses a trailing separator to suggest children of the implied directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tuig-browser-"));
    cleanup.push(cwd);
    await mkdir(join(cwd, "repo"));
    await mkdir(join(cwd, "repo", "src"));
    await mkdir(join(cwd, "repo", ".git"));

    expect(await suggestDirectories("repo/", cwd)).toEqual([
      { name: "src", path: join(cwd, "repo", "src") },
    ]);
  });
});
