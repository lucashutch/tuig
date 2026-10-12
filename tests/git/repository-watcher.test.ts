import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitRepositoryService,
  runGit,
  watchRepository,
  type RepositoryWatcher,
} from "../../src/git/index.js";

const cleanup: string[] = [];
const watchers: RepositoryWatcher[] = [];
const options = { debounceMs: 100, maxWaitMs: 2000, retryMs: 100 };
// Long enough for a debounced report and the ignore check to land.
const SETTLE_MS = 600;

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.close();
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Runs Git the way another terminal would, outside Tuig's process count. */
function externalGit(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd },
  );
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "tuig-watch-"));
  cleanup.push(root);
  externalGit(root, "init", "-q", "-b", "main");
  await Bun.write(join(root, ".gitignore"), "build/\n");
  await Bun.write(join(root, "a.txt"), "a\n");
  externalGit(root, "add", ".");
  externalGit(root, "commit", "-q", "-m", "init");
  return root;
}

async function watch(root: string, onChange: () => boolean = () => true) {
  const repo = await GitRepositoryService.open(root);
  const changes: number[] = [];
  const watcher = watchRepository(
    await repo.watchPaths(),
    (changedAt) => {
      changes.push(changedAt);
      return onChange();
    },
    (error) => {
      throw error;
    },
    options,
  );
  watchers.push(watcher);
  return { changes, watcher };
}

test("a commit from another terminal is reported once", async () => {
  const root = await repository();
  const { changes } = await watch(root);

  await Bun.write(join(root, "a.txt"), "changed\n");
  await Bun.write(join(root, "b.txt"), "new\n");
  externalGit(root, "add", ".");
  externalGit(root, "commit", "-q", "-m", "second");
  await Bun.sleep(SETTLE_MS);

  expect(changes).toHaveLength(1);
});

test("file edits are reported unless Git ignores them", async () => {
  const root = await repository();
  const { changes } = await watch(root);

  await Bun.write(join(root, "build/out.js"), "generated\n");
  await Bun.sleep(SETTLE_MS);
  expect(changes).toHaveLength(0);

  await Bun.write(join(root, "a.txt"), "edited\n");
  await Bun.sleep(SETTLE_MS);
  expect(changes).toHaveLength(1);
});

test("index writes from Tuig's own Git reads do not report a change", async () => {
  const root = await repository();
  // A stat-only change makes the next `git diff` rewrite the index.
  const future = new Date(Date.now() + 86_400_000);
  await utimes(join(root, "a.txt"), future, future);
  await Bun.sleep(50);
  const { changes } = await watch(root);

  await runGit(["diff"], root);
  await Bun.sleep(SETTLE_MS);

  expect(changes).toHaveLength(0);
});

test("a linked worktree sees ref updates in the shared common dir", async () => {
  const root = await repository();
  const linked = join(
    await mkdtemp(join(tmpdir(), "tuig-watch-linked-")),
    "feature",
  );
  cleanup.push(linked);
  externalGit(root, "worktree", "add", "-q", "-b", "feature", linked);
  externalGit(linked, "commit", "-q", "--allow-empty", "-m", "feature");
  const { changes } = await watch(linked);

  // Branch refs live in the main checkout's .git, outside the linked tree.
  externalGit(root, "update-ref", "refs/heads/feature", "main");
  await Bun.sleep(SETTLE_MS);

  expect(changes).toHaveLength(1);
});

test("a change the caller cannot take yet is reported again", async () => {
  const root = await repository();
  let ready = false;
  const { changes } = await watch(root, () => ready);

  await Bun.write(join(root, "a.txt"), "edited\n");
  await Bun.sleep(SETTLE_MS / 2);
  expect(changes.length).toBeGreaterThan(0);
  ready = true;
  const asked = changes.length;
  await Bun.sleep(SETTLE_MS);

  expect(changes).toHaveLength(asked + 1);
});

test("a closed watcher reports nothing", async () => {
  const root = await repository();
  const { changes, watcher } = await watch(root);

  watcher.close();
  await Bun.write(join(root, "a.txt"), "edited\n");
  externalGit(root, "commit", "-q", "-am", "edit");
  await Bun.sleep(SETTLE_MS);

  expect(changes).toHaveLength(0);
});
