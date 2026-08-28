import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitRepositoryService,
  parseLog,
  parseStashes,
  parseRefs,
  parseStatus,
  parseSubmoduleNames,
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
  test("parses distinct author and committer fields without splitting message fields", () => {
    const log =
      "sha\x1fparent\x1fAuthor\x1fauthor@example.com\x1f2020-01-01T00:00:00+00:00\x1fCommitter\x1fcommitter@example.com\x1f2020-01-02T00:00:00+00:00\x1fsubject\x1fHEAD -> main\x1fbody\x1fwith separator\x1e";
    expect(parseLog(log)[0]).toMatchObject({
      author: "Author",
      committer: "Committer",
      committerEmail: "committer@example.com",
      committedAt: "2020-01-02T00:00:00+00:00",
      subject: "subject",
      decorations: ["HEAD -> main"],
      body: "body\x1fwith separator",
    });
  });
  test("keeps spaces in ordinary and unmerged paths", () => {
    const ordinary =
      "1 .M N... 100644 100644 100644 abcdef0 abcdef0 path with spaces.txt\0";
    const unmerged =
      "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict name.txt\0";
    expect(parseStatus(ordinary)[0]?.path).toBe("path with spaces.txt");
    expect(parseStatus(unmerged)[0]?.path).toBe("conflict name.txt");
    expect(parseStatus(unmerged)[0]?.state).toBe("conflicted");
  });
  test("keeps tabs in stash subjects", () => {
    expect(
      parseStashes("stash@{0}\tabc\t2 hours ago\tfix\twith tab\0"),
    ).toEqual([
      {
        ref: "stash@{0}",
        sha: "abc",
        createdAt: "2 hours ago",
        subject: "fix\twith tab",
      },
    ]);
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
  test("maps NUL-delimited .gitmodules paths to config names", () => {
    const names = parseSubmoduleNames(
      "submodule.library.path\nlibs/my library\0submodule.deep.module.path\nmodules/nested path\0",
    );
    expect(
      parseSubmodules(
        ` 1234567890123456789012345678901234567890 modules/nested path\n`,
        names,
      )[0],
    ).toMatchObject({
      path: "modules/nested path",
      name: "deep.module",
    });
  });
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
  await Bun.write(join(root, "odd name.txt"), "stashed\n");
  await repo.stash("visible stash");
  expect((await repo.snapshot()).stashes[0]).toMatchObject({
    ref: "stash@{0}",
    subject: expect.stringContaining("visible stash"),
  });
});

test("snapshot enriches recursively reported submodules with .gitmodules names", async () => {
  const source = await mkdtemp(join(tmpdir(), "tuig-submodule-source-"));
  const root = await mkdtemp(join(tmpdir(), "tuig-submodule-test-"));
  cleanup.push(source, root);
  await runGit(["init", "-b", "main"], source);
  await runGit(["config", "user.name", "Test User"], source);
  await runGit(["config", "user.email", "test@example.com"], source);
  await Bun.write(join(source, "readme"), "source\n");
  await runGit(["add", "readme"], source);
  await runGit(["commit", "-m", "source"], source);
  await runGit(["init", "-b", "main"], root);
  await runGit(
    [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      source,
      "modules/nested path",
    ],
    root,
  );
  await Bun.write(
    join(root, ".gitmodules"),
    `[submodule "library repository"]\n\tpath = modules/nested path\n\turl = ${source}\n`,
  );

  const snapshot = await (await GitRepositoryService.open(root)).snapshot();
  expect(snapshot.submodules).toMatchObject([
    { path: "modules/nested path", name: "library repository" },
  ]);
});

test("fetch prunes remote-tracking branches deleted on the remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-fetch-test-"));
  const remote = await mkdtemp(join(tmpdir(), "tuig-fetch-remote-"));
  cleanup.push(root, remote);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  await Bun.write(join(root, "file"), "initial\n");
  await runGit(["add", "file"], root);
  await runGit(["commit", "-m", "initial"], root);
  await runGit(["clone", "--bare", root, remote]);
  await runGit(["remote", "add", "origin", remote], root);
  await runGit(["switch", "-c", "topic"], root);
  await runGit(["push", "-u", "origin", "topic"], root);
  const repo = await GitRepositoryService.open(root);
  expect(
    (await repo.snapshot()).branches.some((ref) => ref.name === "origin/topic"),
  ).toBe(true);
  await runGit(["push", "origin", "--delete", "topic"], root);
  await repo.fetch();
  expect(
    (await repo.snapshot()).branches.some((ref) => ref.name === "origin/topic"),
  ).toBe(false);
});

test("snapshot tolerates a malformed .gitmodules file", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-submodule-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await Bun.write(join(root, ".gitmodules"), "[submodule broken\n");
  await expect(
    (await GitRepositoryService.open(root)).snapshot(),
  ).resolves.toMatchObject({
    submodules: [],
  });
});

test("amends HEAD using only staged changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);
  await Bun.write(join(root, "staged.txt"), "one\n");
  await repo.stage(["staged.txt"]);
  await repo.commit("initial");
  await Bun.write(join(root, "staged.txt"), "two\n");
  await repo.stage(["staged.txt"]);
  await Bun.write(join(root, "unstaged.txt"), "leave me\n");
  await repo.amendCommit("amended\n\nfull message");
  expect((await repo.snapshot()).commits[0]).toMatchObject({
    subject: "amended",
    body: "full message",
  });
  expect(await Bun.file(join(root, "unstaged.txt")).text()).toBe("leave me\n");
  expect((await repo.snapshot()).files).toMatchObject([
    { path: "unstaged.txt", unstaged: true },
  ]);
});

test("rewords a non-HEAD commit and refuses a dirty worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);
  for (const [file, text, subject] of [
    ["a", "a\n", "first"],
    ["b", "b\n", "second"],
  ] as const) {
    await Bun.write(join(root, file), text);
    await repo.stage([file]);
    await repo.commit(subject);
  }
  const first = (await repo.snapshot()).commits.find(
    (commit) => commit.subject === "first",
  )!;
  await Bun.write(join(root, "dirty"), "x");
  await expect(repo.rewordCommit(first.sha, "renamed")).rejects.toThrow(
    "dirty worktree",
  );
  await runGit(["clean", "-fd"], root);
  await repo.rewordCommit(first.sha, "renamed\n\nnew body");
  const commits = (await repo.snapshot()).commits;
  expect(commits.map((commit) => commit.subject)).toEqual([
    "second",
    "renamed",
  ]);
  expect(commits[1]).toMatchObject({ body: "new body", author: "Test User" });
  expect(await Bun.file(join(root, "a")).text()).toBe("a\n");
  expect(await Bun.file(join(root, "b")).text()).toBe("b\n");
});

test("rewords root and HEAD commits without changing their trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);
  await Bun.write(join(root, "root.txt"), "root\n");
  await repo.stage(["root.txt"]);
  await repo.commit("root");
  const rootSha = (await repo.snapshot()).commits[0]!.sha;
  const rootTree = (
    await runGit(["show", "-s", "--format=%T", rootSha], root)
  ).stdout.trim();
  await repo.rewordCommit(rootSha, "renamed root");
  expect((await runGit(["log", "-1", "--format=%s"], root)).stdout.trim()).toBe(
    "renamed root",
  );
  expect(
    (await runGit(["show", "-s", "--format=%T", "HEAD"], root)).stdout.trim(),
  ).toBe(rootTree);

  await Bun.write(join(root, "head.txt"), "head\n");
  await repo.stage(["head.txt"]);
  await repo.commit("head");
  const headSha = (await runGit(["rev-parse", "HEAD"], root)).stdout.trim();
  const headTree = (
    await runGit(["show", "-s", "--format=%T", "HEAD"], root)
  ).stdout.trim();
  await repo.rewordCommit(headSha, "renamed head");
  expect((await runGit(["log", "-1", "--format=%s"], root)).stdout.trim()).toBe(
    "renamed head",
  );
  expect(
    (await runGit(["show", "-s", "--format=%T", "HEAD"], root)).stdout.trim(),
  ).toBe(headTree);
});

test("rewords merge commits while preserving merge topology and tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);
  const commit = async (file: string, text: string, message: string) => {
    await Bun.write(join(root, file), text);
    await repo.stage([file]);
    await repo.commit(message);
  };
  await commit("base", "base\n", "base");
  await repo.createBranch("topic");
  await repo.switchBranch("topic");
  await commit("topic", "topic\n", "topic");
  await repo.switchBranch("main");
  await commit("main", "main\n", "main");
  await runGit(["merge", "--no-ff", "topic", "-m", "merge topic"], root);
  const merge = (await runGit(["rev-parse", "HEAD"], root)).stdout.trim();
  const tree = (
    await runGit(["show", "-s", "--format=%T", "HEAD"], root)
  ).stdout.trim();
  await repo.rewordCommit(merge, "renamed merge");
  expect((await runGit(["log", "-1", "--format=%s"], root)).stdout.trim()).toBe(
    "renamed merge",
  );
  expect(
    (await runGit(["show", "-s", "--format=%P", "HEAD"], root)).stdout
      .trim()
      .split(" "),
  ).toHaveLength(2);
  expect(
    (await runGit(["show", "-s", "--format=%T", "HEAD"], root)).stdout.trim(),
  ).toBe(tree);
});

test("aborts a failed reword rebase before cleaning up helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);
  await Bun.write(join(root, "a"), "a\n");
  await repo.stage(["a"]);
  await repo.commit("first");
  const sha = (await runGit(["rev-parse", "HEAD"], root)).stdout.trim();
  const hook = join(root, ".git", "hooks", "pre-commit");
  await Bun.write(hook, "#!/bin/sh\nexit 1\n");
  await Bun.spawn(["chmod", "+x", hook]).exited;
  await expect(repo.rewordCommit(sha, "will fail")).rejects.toThrow();
  await expect(
    runGit(["rev-parse", "--verify", "REBASE_HEAD"], root),
  ).rejects.toThrow();
  expect((await runGit(["status", "--porcelain"], root)).stdout).toBe("");
});

test("checks out commits and branches, resets, and rebases", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);
  const write = async (name: string, body: string, message: string) => {
    await Bun.write(join(root, name), body);
    await repo.stage([name]);
    await repo.commit(message);
  };
  await write("a.txt", "one\n", "first");
  const first = (await repo.snapshot()).commits[0]!.sha;
  await write("b.txt", "two\n", "second");

  await repo.checkoutCommit(first);
  expect((await repo.snapshot()).branch).toBeUndefined();
  await repo.switchBranch("main");

  // A bare clone stands in for a remote, so the remote-tracking checkout path
  // runs against a real ref rather than a fabricated one.
  const remote = await mkdtemp(join(tmpdir(), "tuig-remote-"));
  cleanup.push(remote);
  await runGit(["clone", "--bare", root, remote]);
  await runGit(["remote", "add", "origin", remote], root);
  await runGit(["fetch", "origin"], root);
  await repo.checkoutRemoteBranch("copy", "origin/main");
  expect((await repo.snapshot()).branch).toBe("copy");

  const headSubject = async () =>
    (await runGit(["log", "-1", "--format=%s"], root)).stdout.trim();
  await repo.resetTo(first, "hard");
  expect(await headSubject()).toBe("first");
  // `copy` now trails the remote, so the reset checkout must move it forward.
  await repo.switchBranch("main");
  await repo.checkoutRemoteBranch("copy", "origin/main", true);
  const snapshot = await repo.snapshot();
  expect(snapshot.branch).toBe("copy");
  expect(await headSubject()).toBe("second");

  await repo.resetTo(first, "hard");
  await repo.rebaseOnto("main");
  expect(await headSubject()).toBe("second");
});

test("creates branches and lightweight tags, cherry-picks, and manages stashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-actions-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);

  await Bun.write(join(root, "file"), "base\n");
  await repo.stage(["file"]);
  await repo.commit("base");
  await repo.createBranch("topic", undefined, true);
  await Bun.write(join(root, "topic"), "topic\n");
  await repo.stage(["topic"]);
  await repo.commit("topic change");
  const topicCommit = (await runGit(["rev-parse", "HEAD"], root)).stdout.trim();
  await repo.switchBranch("main");
  await repo.cherryPick(topicCommit);
  expect((await repo.snapshot()).branch).toBe("main");
  expect(await Bun.file(join(root, "topic")).text()).toBe("topic\n");

  await repo.createTag("v1", topicCommit);
  expect(
    (await runGit(["cat-file", "-t", "refs/tags/v1"], root)).stdout.trim(),
  ).toBe("commit");
  expect((await runGit(["rev-parse", "v1"], root)).stdout.trim()).toBe(
    topicCommit,
  );
  await repo.createTag("head-tag");
  expect((await runGit(["rev-parse", "head-tag"], root)).stdout.trim()).toBe(
    (await runGit(["rev-parse", "HEAD"], root)).stdout.trim(),
  );

  await Bun.write(join(root, "file"), "stashed\n");
  await repo.stash("keep this");
  const stashRef = (await repo.snapshot()).stashes[0]!.ref;
  await repo.applyStash(stashRef);
  expect(await Bun.file(join(root, "file")).text()).toBe("stashed\n");
  await repo.discardAll();
  await repo.popStash(stashRef);
  expect(await Bun.file(join(root, "file")).text()).toBe("stashed\n");
  expect((await repo.snapshot()).stashes).toHaveLength(0);

  await Bun.write(join(root, "file"), "drop me\n");
  await repo.stash("drop this");
  const dropRef = (await repo.snapshot()).stashes[0]!.ref;
  await repo.dropStash(dropRef);
  expect((await repo.snapshot()).stashes).toHaveLength(0);
});

test("rejects empty or invalid tag names before creating a ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-tag-validation-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  await Bun.write(join(root, "file"), "base\n");
  await runGit(["add", "file"], root);
  await runGit(["commit", "-m", "base"], root);
  const repo = await GitRepositoryService.open(root);

  for (const name of ["", "   ", "invalid..name", "invalid~name"]) {
    await expect(repo.createTag(name)).rejects.toThrow();
  }
  expect((await runGit(["tag", "--list"], root)).stdout).toBe("");
});

test("workingStatus reports the same working state as a full snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  await Bun.write(join(root, "a.txt"), "one\n");
  await Bun.write(join(root, "b.txt"), "two\n");
  const repo = await GitRepositoryService.open(root);
  await repo.stage(["a.txt"]);
  await repo.commit("initial");
  await Bun.write(join(root, "a.txt"), "changed\n");
  await repo.stage(["a.txt"]);
  await Bun.write(join(root, "a.txt"), "changed again\n");
  const snapshot = await repo.snapshot();
  const status = await repo.workingStatus();
  expect(status.files).toEqual(snapshot.files);
  expect(status.ahead).toBe(snapshot.ahead);
  expect(status.behind).toBe(snapshot.behind);
  expect(status.upstream).toBe(snapshot.upstream);
});

test("history is ordered newest first across every ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);
  const commit = async (name: string, at: string) => {
    await Bun.write(join(root, `${name}.txt`), `${name}\n`);
    await repo.stage([`${name}.txt`]);
    await runGit(["commit", "-m", name], root, {
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_DATE: at,
    });
  };
  await commit("first", "2020-01-01T00:00:00+00:00");
  await commit("second", "2020-01-02T00:00:00+00:00");
  await runGit(["switch", "-c", "side", "HEAD~1"], root);
  await commit("side", "2020-01-03T00:00:00+00:00");
  // The walk drops --date-order for speed, so assert the ordering it relies on.
  const commits = (await repo.snapshot()).commits;
  expect(commits.map((entry) => entry.subject)).toEqual([
    "side",
    "second",
    "first",
  ]);
});

test("history pages report whether older commits remain", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  const repo = await GitRepositoryService.open(root);
  for (const name of ["one", "two", "three", "four"]) {
    await Bun.write(join(root, `${name}.txt`), `${name}\n`);
    await repo.stage([`${name}.txt`]);
    await repo.commit(name);
  }
  const first = await repo.commitPage(2);
  expect(first.commits.map((commit) => commit.subject)).toEqual([
    "four",
    "three",
  ]);
  expect(first.complete).toBe(false);
  const second = await repo.commitPage(4);
  expect(second.commits).toHaveLength(4);
  expect(second.complete).toBe(true);
  // A page larger than the history is still complete, without padding.
  const third = await repo.commitPage(50);
  expect(third.commits).toHaveLength(4);
  expect(third.complete).toBe(true);
  const snapshot = await repo.snapshot(2);
  expect(snapshot.commits).toHaveLength(2);
  expect(snapshot.commitsComplete).toBe(false);
  // A skipped page continues the same walk, so the caller can append it to
  // what it already holds after checking the overlapping commit.
  const continued = await repo.commitPage(3, 1);
  expect(continued.commits.map((commit) => commit.subject)).toEqual([
    "three",
    "two",
    "one",
  ]);
  expect(continued.complete).toBe(true);
  expect(continued.commits[0]?.sha).toBe(first.commits[1]?.sha);
});

test("an empty repository reports complete, empty history", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-test-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  const repo = await GitRepositoryService.open(root);
  const page = await repo.commitPage(250);
  expect(page.commits).toEqual([]);
  expect(page.complete).toBe(true);
});
