import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitRepositoryService,
  parseRefs,
  parseStatus,
  parseSubmodules,
  parseWorktrees,
  runGit,
} from "../../src/git/repository.js";
import { splitPatchHunks } from "../../src/git/hunks.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("porcelain parsers", () => {
  test("keeps spaces in ordinary and unmerged paths", () => {
    const ordinary =
      "1 .M N... 100644 100644 100644 abcdef0 abcdef0 path with spaces.txt\0";
    const unmerged =
      "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict name.txt\0";
    expect(parseStatus(ordinary)[0]?.path).toBe("path with spaces.txt");
    expect(parseStatus(unmerged)[0]?.path).toBe("conflict name.txt");
    expect(parseStatus(unmerged)[0]?.state).toBe("conflicted");
  });

  test("parses full worktree SHA and normalizes branch", () => {
    const sha = "1234567890123456789012345678901234567890";
    expect(
      parseWorktrees(
        `worktree /repo\nHEAD ${sha}\nbranch refs/heads/main\n\n`,
      )[0],
    ).toMatchObject({ path: "/repo", sha, branch: "main" });
  });
  test("separates submodule path and description", () =>
    expect(
      parseSubmodules(
        ` 1234567890123456789012345678901234567890 libs/my lib (heads/main)\n`,
      )[0],
    ).toMatchObject({ path: "libs/my lib", description: "heads/main" }));
  test("splits a patch while retaining file headers", () => {
    const patch =
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d\n";
    expect(splitPatchHunks(patch)).toHaveLength(2);
    expect(splitPatchHunks(patch)[1]?.patch).toContain("diff --git");
  });
});

describe("ref parser", () => {
  test("parses multiple local and remote refs and marks the current branch", () => {
    const sha = "1234567890123456789012345678901234567890";
    expect(
      parseRefs(
        `refs/heads/main\t${sha}\t*\0\nrefs/heads/feature/x\t${sha}\t\0\nrefs/remotes/origin/main\t${sha}\t\0`,
      ),
    ).toMatchObject([
      {
        name: "main",
        fullName: "refs/heads/main",
        current: true,
        remote: false,
      },
      {
        name: "feature/x",
        fullName: "refs/heads/feature/x",
        current: false,
        remote: false,
      },
      {
        name: "origin/main",
        fullName: "refs/remotes/origin/main",
        current: false,
        remote: true,
      },
    ]);
  });
});

test("repository stages, commits, and reports an odd filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  await Bun.write(join(root, "odd name.txt"), "one\n");
  const repo = await GitRepositoryService.open(root);
  expect((await repo.snapshot()).files[0]?.path).toBe("odd name.txt");
  expect(await repo.diff({ path: "odd name.txt" })).toContain("+one");
  await repo.stage(["odd name.txt"]);
  await repo.commit("initial");
  expect((await repo.snapshot()).commits[0]?.subject).toBe("initial");
  expect(await repo.commitFiles("HEAD")).toMatchObject([
    { path: "odd name.txt", state: "added" },
  ]);
  await Bun.write(join(root, "odd name.txt"), "one\ntwo\n");
  expect(await repo.diff({ path: "odd name.txt" })).toContain("+two");
  await repo.stage(["odd name.txt"]);
  await repo.commit("second");
  const commits = (await repo.snapshot()).commits;
  expect(commits).toHaveLength(2);
  expect(commits.every((commit) => /^[0-9a-f]{40}$/.test(commit.sha))).toBe(
    true,
  );
  expect(await repo.commitFiles(commits[1]!.sha)).toMatchObject([
    { path: "odd name.txt", state: "added" },
  ]);
});
