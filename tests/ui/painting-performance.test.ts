import { describe, expect, test } from "bun:test";
import type { TextRenderable } from "@opentui/core";
import type {
  BranchRef,
  ChangedFile,
  RepositorySnapshot,
} from "../../src/git/types.js";
import {
  cachedFileTree,
  cachedFlattenVisible,
} from "../../src/ui/file-tree.js";
import { decorationRefIndexFor } from "../../src/ui/history.js";
import {
  files,
  sectionRows,
  type RuntimeFilesContext,
} from "../../src/ui/runtime-files.js";
import {
  renderSidebarViewport,
  renderSidebarViewportRows,
  renderSubmoduleSidebarViewport,
  sidebarRowSource,
  sidebarRows,
} from "../../src/ui/runtime-presentation-sidebar.js";

const changed = (path: string, staged = false): ChangedFile => ({
  path,
  state: "modified",
  staged,
  unstaged: !staged,
});
const snapshot = (fileList: ChangedFile[] = []): RepositorySnapshot => ({
  root: "/repo",
  ahead: 0,
  behind: 0,
  files: fileList,
  branches: [],
  stashes: [],
  worktrees: [],
  submodules: [],
  commits: [],
  commitsComplete: true,
});
const filesContext = (
  s: RepositorySnapshot,
  commitFiles: ChangedFile[] = [],
): RuntimeFilesContext => ({
  snapshot: s,
  commitFiles,
  view: "history",
  mode: "unstaged",
  fileIndex: 0,
  fileStart: 0,
  sectionCollapsed: { staged: false, unstaged: false },
  sectionStart: { staged: 0, unstaged: 0 },
  expandedFiles: new Set(),
  contentHeight: 10,
  commitFilesTop: 0,
  widgets: {
    unstagedText: {} as TextRenderable,
    stagedText: {} as TextRenderable,
    commitDiff: { visible: false },
    commitDiffEmpty: {} as TextRenderable,
  },
  sectionViewport: () => 5,
  setFocus: () => {},
  layout: () => {},
  paint: () => {},
  paintFiles: () => {},
  loadDiff: async () => {},
  openWorkingDiff: async () => {},
  notify: () => {},
  fail: () => {},
  persistLayoutPreferences: () => {},
  openFileMenu: () => {},
});

describe("paint caches", () => {
  test("filter results follow query section and snapshot replacement", () => {
    const first = snapshot([changed("a"), changed("b", true)]),
      ctx = filesContext(first);
    expect(files(ctx, "unstaged").map((f) => f.path)).toEqual(["a"]);
    expect(files(ctx, "staged").map((f) => f.path)).toEqual(["b"]);
    expect(files(ctx, "staged")).toBe(files(ctx, "staged"));
    ctx.snapshot = snapshot([changed("c", true)]);
    expect(files(ctx, "staged").map((f) => f.path)).toEqual(["c"]);
  });

  test("commit array replacement and expansion mutation invalidate by identity/content", () => {
    const ctx = filesContext(snapshot(), [changed("one/a")]);
    ctx.view = "commit";
    const closed = sectionRows(ctx, "unstaged");
    ctx.expandedFiles.add("one");
    const open = sectionRows(ctx, "unstaged");
    expect(open.length).toBeGreaterThan(closed.length);
    expect(sectionRows(ctx, "unstaged")).toBe(open);
    ctx.commitFiles = [changed("two/b")];
    expect(sectionRows(ctx, "unstaged")[0]?.node.name).toBe("two");
  });

  test("tree cache is scoped to source array identity", () => {
    const source = [changed("a")];
    expect(cachedFileTree(source)).toBe(cachedFileTree(source));
    expect(cachedFileTree([...source])).not.toBe(cachedFileTree(source));
    const tree = cachedFileTree(source),
      expanded = new Set<string>();
    expect(cachedFlattenVisible(tree, expanded)).toBe(
      cachedFlattenVisible(tree, expanded),
    );
  });
});

describe("indexed sidebar rendering", () => {
  test("matches eager output while scrolling and does not request offscreen rows", () => {
    const rows = ["a", "b", "c", "d"],
      requested: number[] = [];
    expect(
      renderSidebarViewportRows(
        rows.length,
        (i) => (requested.push(i), rows[i]),
        8,
        1,
        2,
      ),
    ).toEqual(renderSidebarViewport(rows, 8, 1, 2));
    expect(requested).toEqual([1, 2]);
    expect(renderSidebarViewportRows(0, () => undefined, 8, 0, 2)[0]).toContain(
      "(none",
    );
  });

  test("branch filter, aliases, order, and replacement invalidate indexes", () => {
    const ref = (
      name: string,
      fullName: string,
      remote = false,
    ): BranchRef => ({ name, fullName, remote, current: false, sha: name });
    const branches = [
      ref("main", "refs/heads/main"),
      ref("origin/main", "refs/remotes/origin/main", true),
      ref("feature", "refs/heads/feature"),
    ];
    const s = snapshot();
    s.branches = branches;
    expect(sidebarRowSource(s, "local", 20, "feat").total).toBe(1);
    expect(sidebarRows(s, "local", 20).length).toBe(2);
    const index = decorationRefIndexFor(branches);
    expect(index.get("main")).toBe(branches[0]);
    expect(index.get("origin/main")).toBe(branches[1]);
    expect(decorationRefIndexFor([...branches])).not.toBe(index);
  });

  test("multiline submodule viewport remains equivalent", () => {
    const modules = [
      { path: "vendor/one", sha: "1", state: "different" as const },
      { path: "two", sha: "2", state: "clean" as const },
    ];
    const text = renderSubmoduleSidebarViewport(modules, 18, 1, 2);
    const plain = text.chunks.map((chunk) => chunk.text).join("");
    expect(plain).toContain("vendor/one");
    expect(plain).toContain("two");
  });
});
