import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hunkAtRow,
  selectPatchLines,
  splitPatchHunks,
} from "../../src/git/hunks.js";
import { GitRepositoryService, runGit } from "../../src/git/repository.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const patch = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,4 +1,5 @@",
  " same",
  "-old one",
  "-old two",
  "+new one",
  "+new two",
  "+extra",
  " tail",
  "",
].join("\n");

describe("partial line patches", () => {
  test("keeps selected additions and omits adjacent additions", () => {
    const selected = selectPatchLines(patch, new Set([7, 9]));
    expect(selected).toContain("+new one");
    expect(selected).toContain("+extra");
    expect(selected).not.toContain("+new two");
    expect(selected).toContain("@@ -1,4 +1,6 @@");
  });

  test("turns unselected removals into context", () => {
    const selected = selectPatchLines(patch, new Set([5]));
    expect(selected).toContain("-old one");
    expect(selected).toContain(" old two");
    expect(selected).not.toContain("+new one");
    expect(selected).toContain("@@ -1,4 +1,3 @@");
  });

  test("returns no patch without selected changes", () => {
    expect(selectPatchLines(patch, new Set())).toBe("");
    expect(selectPatchLines(patch, new Set([4]))).toBe("");
  });

  test("drops a no-newline marker with an omitted line", () => {
    const withMarker = patch.replace(
      "+new two\n+extra",
      "+new two\n\\ No newline at end of file\n+extra",
    );
    const selected = selectPatchLines(
      withMarker,
      new Set([withMarker.split("\n").indexOf("+extra")]),
    );
    expect(selected).toContain("+extra");
    expect(selected).not.toContain("No newline at end of file");
  });

  test("stages, unstages, and discards only selected lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "tuig-lines-"));
    cleanup.push(root);
    await runGit(["init", "-b", "main"], root);
    const path = join(root, "a.txt");
    await Bun.write(path, "one\ntwo\nthree\n");
    await runGit(["add", "a.txt"], root);
    await runGit(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "base",
      ],
      root,
    );
    await Bun.write(path, "ONE\ntwo\nTHREE\n");
    const repo = await GitRepositoryService.open(root);
    const diff = await repo.diff({ path: "a.txt", context: 3 });
    const rows = diff.split("\n");
    const oneRows = new Set([rows.indexOf("-one"), rows.indexOf("+ONE")]);
    const onePatch = selectPatchLines(diff, oneRows);

    await repo.applyPatch(onePatch);
    expect((await runGit(["show", ":a.txt"], root)).stdout).toBe(
      "ONE\ntwo\nthree\n",
    );
    const stagedDiff = await repo.diff({
      path: "a.txt",
      staged: true,
      context: 3,
    });
    const stagedRows = stagedDiff.split("\n");
    await repo.applyPatch(
      selectPatchLines(
        stagedDiff,
        new Set([stagedRows.indexOf("-one"), stagedRows.indexOf("+ONE")]),
        "new",
      ),
      true,
    );
    expect((await runGit(["show", ":a.txt"], root)).stdout).toBe(
      "one\ntwo\nthree\n",
    );
    await repo.discardPatch(selectPatchLines(diff, oneRows, "new"));
    expect(await readFile(path, "utf8")).toBe("one\ntwo\nTHREE\n");

    await Bun.write(path, "ONE\ntwo\nTHREE\n");
    await repo.stage(["a.txt"]);
    const fullStagedDiff = await repo.diff({
      path: "a.txt",
      staged: true,
      context: 3,
    });
    const fullStagedRows = fullStagedDiff.split("\n");
    await repo.applyPatch(
      selectPatchLines(
        fullStagedDiff,
        new Set([
          fullStagedRows.indexOf("-one"),
          fullStagedRows.indexOf("+ONE"),
        ]),
        "new",
      ),
      true,
    );
    expect((await runGit(["show", ":a.txt"], root)).stdout).toBe(
      "one\ntwo\nTHREE\n",
    );
    expect(await readFile(path, "utf8")).toBe("ONE\ntwo\nTHREE\n");
  });

  test("stages, unstages, and reverts one hunk of a two-hunk file", async () => {
    const root = await mkdtemp(join(tmpdir(), "tuig-hunks-"));
    cleanup.push(root);
    await runGit(["init", "-b", "main"], root);
    const path = join(root, "a.txt");
    const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    await Bun.write(path, `${base.join("\n")}\n`);
    await runGit(["add", "a.txt"], root);
    await runGit(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "base",
      ],
      root,
    );
    const edited = [...base];
    edited[1] = "TOP";
    edited[27] = "BOTTOM";
    await Bun.write(path, `${edited.join("\n")}\n`);
    const repo = await GitRepositoryService.open(root);
    const diff = await repo.diff({ path: "a.txt", context: 3 });
    const rows = diff.split("\n");
    const hunks = splitPatchHunks(diff);
    expect(hunks).toHaveLength(2);
    const bottomRow = rows.indexOf("+BOTTOM");
    expect(hunkAtRow(diff, bottomRow)?.index).toBe(1);

    await repo.applyPatch(hunkAtRow(diff, bottomRow)!.patch);
    const staged = (await runGit(["show", ":a.txt"], root)).stdout.split("\n");
    expect(staged[27]).toBe("BOTTOM");
    expect(staged[1]).toBe("line 2");

    const stagedDiff = await repo.diff({
      path: "a.txt",
      staged: true,
      context: 3,
    });
    await repo.applyPatch(splitPatchHunks(stagedDiff)[0]!.patch, true);
    expect((await runGit(["show", ":a.txt"], root)).stdout).toBe(
      `${base.join("\n")}\n`,
    );

    const topRow = rows.indexOf("+TOP");
    await repo.discardPatch(hunkAtRow(diff, topRow)!.patch);
    const worktree = (await readFile(path, "utf8")).split("\n");
    expect(worktree[1]).toBe("line 2");
    expect(worktree[27]).toBe("BOTTOM");
  });

  test("finds no hunk for header rows", () => {
    expect(hunkAtRow(patch, 1)).toBeUndefined();
    expect(hunkAtRow(patch, 5)?.index).toBe(0);
  });
});
