import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitRepositoryService, runGit } from "../src/git/repository";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tuig-undo-test-"));
  roots.push(root);
  const git = async (...args: string[]) =>
    (await runGit(args, root)).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  const commit = async (content: string) => {
    await Bun.write(join(root, "file"), content);
    await git("add", "file");
    await git("commit", "-m", content);
    return git("rev-parse", "HEAD");
  };
  const initial = await commit("initial\n");
  const repo = await GitRepositoryService.open(root);
  return { root, git, commit, initial, repo };
}

for (const operation of ["commit", "amend", "reset", "merge"] as const) {
  test(`undo restores the previous tip and tree after ${operation}`, async () => {
    const { root, git, commit, initial, repo } = await fixture();
    let target = initial;
    let content = "initial\n";
    if (operation === "commit") await commit("new\n");
    if (operation === "amend") {
      await Bun.write(join(root, "file"), "amended\n");
      await git("add", "file");
      await git("commit", "--amend", "-m", "amended");
    }
    if (operation === "reset") {
      target = await commit("new\n");
      content = "new\n";
      await git("reset", "--hard", initial);
    }
    if (operation === "merge") {
      await git("switch", "-c", "topic");
      await commit("topic\n");
      await git("switch", "main");
      await git("merge", "--no-ff", "topic", "-m", "merge");
    }
    const preview = await repo.getUndoPreview();
    expect(preview.target).toBe(target);
    await repo.undo(preview);
    expect(await git("rev-parse", "HEAD")).toBe(target);
    expect(await readFile(join(root, "file"), "utf8")).toBe(content);
    expect(await git("status", "--porcelain")).toBe("");
    await expect(repo.getUndoPreview()).rejects.toThrow("previous undo");
  });
}

test("dirty tracked, staged and untracked data are preserved", async () => {
  const { root, git, commit, repo } = await fixture();
  await commit("new\n");
  const preview = await repo.getUndoPreview();
  await Bun.write(join(root, "file"), "staged\n");
  await git("add", "file");
  await Bun.write(join(root, "file"), "unstaged\n");
  await Bun.write(join(root, "untracked"), "keep\n");
  const before = await git("status", "--porcelain");
  await expect(repo.undo(preview)).rejects.toThrow(
    "tracked changes or untracked",
  );
  expect(await git("status", "--porcelain")).toBe(before);
  expect(await readFile(join(root, "file"), "utf8")).toBe("unstaged\n");
  expect(await readFile(join(root, "untracked"), "utf8")).toBe("keep\n");
  await git("reset", "--hard", "HEAD");
  await expect(repo.getUndoPreview()).rejects.toThrow("untracked");
});

test("undo preserves ignored content that the target would overwrite", async () => {
  const { root, git, repo } = await fixture();
  await Bun.write(join(root, "artifact"), "original\n");
  await git("add", "artifact");
  await git("commit", "-m", "track artifact");
  await git("rm", "artifact");
  await Bun.write(join(root, ".gitignore"), "artifact\n");
  await git("add", ".gitignore");
  await git("commit", "-m", "ignore artifact");
  const preview = await repo.getUndoPreview();
  await Bun.write(join(root, "artifact"), "precious ignored content\n");
  expect(await git("status", "--porcelain")).toBe("");
  await expect(repo.getUndoPreview()).rejects.toThrow(
    "ignored untracked files",
  );
  await expect(repo.undo(preview)).rejects.toThrow("ignored untracked files");
  expect(await git("rev-parse", "HEAD")).toBe(preview.head);
  expect(await readFile(join(root, "artifact"), "utf8")).toBe(
    "precious ignored content\n",
  );
});

test("same-hash reflog entries and modified previews are stale", async () => {
  const { git, commit, repo } = await fixture();
  await commit("new\n");
  const preview = await repo.getUndoPreview();
  await expect(repo.undo({ ...preview, target: preview.head })).rejects.toThrow(
    "stale",
  );
  await git("reset", "--hard", "HEAD");
  await expect(repo.getUndoPreview()).rejects.toThrow("did not move HEAD");
  await expect(repo.undo(preview)).rejects.toThrow("did not move HEAD");
  await git("reset", "--hard", preview.target);
  await git("reset", "--hard", preview.head);
  await expect(repo.undo(preview)).rejects.toThrow("stale");
});

test("custom unsupported reflog actions are refused without skipping", async () => {
  const { root, git, commit, initial, repo } = await fixture();
  await commit("new\n");
  await runGit(["reset", "--hard", initial], root, {
    GIT_REFLOG_ACTION: "custom operation",
  });
  await expect(repo.getUndoPreview()).rejects.toThrow(
    "unsupported reflog action: custom operation",
  );
  expect(await git("rev-parse", "HEAD")).toBe(initial);
});

test("undo does not recurse into submodules when configured to recurse", async () => {
  const child = await fixture();
  const { root, git, repo } = await fixture();
  await git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    child.root,
    "nested",
  );
  await git("commit", "-am", "add submodule");
  const target = await git("rev-parse", "HEAD");
  const nested = join(root, "nested");
  const nestedGit = async (...args: string[]) =>
    (await runGit(args, nested)).stdout.trim();
  await nestedGit("config", "user.name", "Test");
  await nestedGit("config", "user.email", "test@example.com");
  await Bun.write(join(nested, "file"), "nested new\n");
  await nestedGit("commit", "-am", "nested new");
  const nestedHead = await nestedGit("rev-parse", "HEAD");
  const nestedBranch = await nestedGit("symbolic-ref", "HEAD");
  await git("add", "nested");
  await git("commit", "-m", "advance submodule");
  await git("config", "submodule.recurse", "true");
  await repo.undo(await repo.getUndoPreview());
  expect(await git("rev-parse", "HEAD")).toBe(target);
  expect(await nestedGit("rev-parse", "HEAD")).toBe(nestedHead);
  expect(await nestedGit("symbolic-ref", "HEAD")).toBe(nestedBranch);
  expect(await readFile(join(nested, "file"), "utf8")).toBe("nested new\n");
});

for (const targetDirectory of [false, true]) {
  test(`undo refuses ignored prefix collision with target ${targetDirectory ? "directory" : "file"}`, async () => {
    const { root, git, repo } = await fixture();
    if (targetDirectory) await mkdir(join(root, "artifact"));
    await Bun.write(
      join(root, targetDirectory ? "artifact/file" : "artifact"),
      "original\n",
    );
    await git("add", "artifact");
    await git("commit", "-m", "track artifact");
    await git("rm", "-r", "artifact");
    await Bun.write(join(root, ".gitignore"), "artifact\n");
    await git("add", ".gitignore");
    await git("commit", "-m", "ignore artifact");
    const preview = await repo.getUndoPreview();
    if (!targetDirectory) await mkdir(join(root, "artifact"));
    const precious = join(
      root,
      targetDirectory ? "artifact" : "artifact/precious",
    );
    await Bun.write(precious, "keep\n");
    await expect(repo.undo(preview)).rejects.toThrow("overlap ignored");
    expect(await readFile(precious, "utf8")).toBe("keep\n");
    expect(await git("rev-parse", "HEAD")).toBe(preview.head);
  });
}

test("undo allows unrelated ignored build directories", async () => {
  const { root, git, commit, initial, repo } = await fixture();
  await Bun.write(join(root, ".gitignore"), "node_modules/\n");
  await git("add", ".gitignore");
  await commit("new\n");
  await mkdir(join(root, "node_modules"));
  await Bun.write(join(root, "node_modules", "dependency"), "keep\n");
  await repo.undo(await repo.getUndoPreview());
  expect(await git("rev-parse", "HEAD")).toBe(initial);
  expect(await readFile(join(root, "node_modules", "dependency"), "utf8")).toBe(
    "keep\n",
  );
});

test("cherry-pick without an identifiable invocation boundary is refused", async () => {
  const { git, commit, repo } = await fixture();
  await git("switch", "-c", "topic");
  const picked = await commit("picked\n");
  await git("switch", "main");
  await git("cherry-pick", picked);
  await expect(repo.getUndoPreview()).rejects.toThrow("unsupported");
});

test("latest checkout, detached HEAD, rebase and active operations are refused", async () => {
  const { root, git, commit, repo } = await fixture();
  await commit("new\n");
  await git("switch", "-c", "topic");
  await expect(repo.getUndoPreview()).rejects.toThrow("unsupported");
  await git("checkout", "--detach");
  await expect(repo.getUndoPreview()).rejects.toThrow("detached");
  await git("switch", "main");
  await git(
    "-c",
    "core.logAllRefUpdates=true",
    "update-ref",
    "-m",
    "rebase (finish): test",
    "HEAD",
    await git("rev-parse", "HEAD"),
  );
  await expect(repo.getUndoPreview()).rejects.toThrow("unsupported");
  await mkdir(join(root, ".git", "rebase-merge"));
  await expect(repo.getUndoPreview()).rejects.toThrow("operation is active");
});
