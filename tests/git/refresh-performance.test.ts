import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GitRepositoryService,
  GitCommandAbortedError,
  GitOutputLimitError,
  runGit,
} from "../../src/git/repository.js";

const roots: string[] = [];
const services: GitRepositoryService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "tuig-refresh-perf-"));
  roots.push(root);
  return root;
}

async function repository(commits = 0) {
  const root = await directory();
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.name", "Test User"], root);
  await runGit(["config", "user.email", "test@example.com"], root);
  for (let i = 0; i < commits; i++)
    await runGit(["commit", "--allow-empty", "-m", `commit ${i}`], root);
  return root;
}

async function open(root: string) {
  const service = await GitRepositoryService.open(root);
  services.push(service);
  return service;
}

test("poll notices unborn branch creation and detached HEAD movement", async () => {
  const root = await repository();
  const repo = await open(root);
  const empty = await repo.snapshot();
  expect(empty.branch).toBe("main");
  expect(empty.commits).toHaveLength(0);
  await runGit(["commit", "--allow-empty", "-m", "one"], root);
  const first = await repo.refreshSnapshot(empty);
  expect(first.commits).toHaveLength(1);
  await runGit(["commit", "--allow-empty", "-m", "two"], root);
  const second = await repo.refreshSnapshot(first);
  await runGit(["checkout", "--detach", "HEAD~1"], root);
  const detached = await repo.refreshSnapshot(second);
  expect(detached.branch).toBeUndefined();
  expect(detached.commits).not.toBe(second.commits);
  expect(
    detached.commits.find((commit) => commit.decorations.includes("HEAD"))?.sha,
  ).toBe(first.commits[0]!.sha);
  const unchanged = await repo.refreshSnapshot(detached);
  expect(unchanged.commits).toBe(detached.commits);
});

test("deepening while still shallow invalidates history without moved refs", async () => {
  const source = await repository(4);
  const root = await directory();
  await runGit(["clone", "--depth=1", pathToFileURL(source).href, root]);
  const repo = await open(root);
  const first = await repo.snapshot();
  expect(first.commits).toHaveLength(1);
  await runGit(["fetch", "--deepen=1"], root);
  expect(
    (
      await runGit(["rev-parse", "--is-shallow-repository"], root)
    ).stdout.trim(),
  ).toBe("true");
  const deeper = await repo.refreshSnapshot(first);
  expect(deeper.branches).toEqual(first.branches);
  expect(deeper.commits).not.toBe(first.commits);
  expect(deeper.commits).toHaveLength(2);
});

test("linked worktrees use the shared graft metadata path", async () => {
  const source = await repository(3);
  const root = await directory();
  await runGit(["worktree", "add", "--detach", root, "HEAD"], source);
  const repo = await open(root);
  const first = await repo.snapshot();
  expect(first.commits).toHaveLength(3);
  const graftPath = (
    await runGit(
      ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"],
      root,
    )
  ).stdout.trim();
  await Bun.write(graftPath, `${first.commits[0]!.sha}\n`);
  const grafted = await repo.refreshSnapshot(first);
  expect(grafted.commits).not.toBe(first.commits);
  expect(grafted.commits).toHaveLength(1);
  await rm(graftPath);
  const restored = await repo.refreshSnapshot(grafted);
  expect(restored.commits).toHaveLength(3);
});

test("paging into the same array retains cheap-refresh eligibility", async () => {
  const repo = await open(await repository(4));
  const first = await repo.snapshot(1);
  const page = await repo.commitPage(2, 1);
  first.commits.push(...page.commits);
  const appended = { ...first, commitsComplete: page.complete };
  const refreshed = await repo.refreshSnapshot(appended, 3);
  expect(refreshed.commits).toBe(first.commits);
  expect(refreshed.commits).toHaveLength(3);
});

test.skipIf(process.platform === "win32")(
  "cancellation and overflow close inherited helper pipes",
  async () => {
    const root = await repository();
    const controller = new AbortController();
    const start = performance.now();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        runGit(
          ["-c", "alias.wait=!sleep 10", "wait"],
          root,
          undefined,
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(GitCommandAbortedError);
      expect(performance.now() - start).toBeLessThan(2000);
    } finally {
      clearTimeout(timer);
    }
    const overflowStart = performance.now();
    await expect(
      runGit(
        ["-c", "alias.emit=!printf overflow; sleep 10", "emit"],
        root,
        undefined,
        undefined,
        1,
      ),
    ).rejects.toBeInstanceOf(GitOutputLimitError);
    expect(performance.now() - overflowStart).toBeLessThan(2000);
  },
);
