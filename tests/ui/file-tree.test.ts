import { describe, expect, test } from "bun:test";
import {
  buildFileTree,
  descendantFiles,
  expandNewDirectories,
  fileRowActionHits,
  fitTreeLabel,
  flattenVisible,
  toggleExpansion,
} from "../../src/ui/file-tree.js";
import type { ChangedFile } from "../../src/git/types.js";

const changed = (
  path: string,
  state: ChangedFile["state"] = "modified",
): ChangedFile => ({ path, state, staged: false, unstaged: true });

describe("changed-file tree", () => {
  test("expands every new folder by default and preserves user collapses", () => {
    const tree = buildFileTree([
      changed("src/deep/a.ts"),
      changed("test/unit/a.test.ts"),
    ]);
    const expanded = new Set<string>();
    const seen = new Set<string>();
    expandNewDirectories(tree, expanded, seen);
    expect([...expanded].sort()).toEqual([
      "src",
      "src/deep",
      "test",
      "test/unit",
    ]);

    expanded.delete("src");
    expandNewDirectories(tree, expanded, seen);
    expect(expanded.has("src")).toBe(false);
  });
  test("folder actions include collapsed descendants and use stable right-aligned hits", () => {
    const tree = buildFileTree([changed("src/a.ts"), changed("src/deep/b.ts")]);
    const src = tree.children[0]!;
    expect(descendantFiles(src).map((file) => file.path)).toEqual([
      "src/deep/b.ts",
      "src/a.ts",
    ]);
    expect(fileRowActionHits("unstaged", 30)).toEqual([
      { action: "stage", label: " Stage ", start: 14, end: 21 },
      { action: "discard", label: " Discard ", start: 21, end: 30 },
    ]);
    expect(fileRowActionHits("unstaged", 20)).toEqual([]);
    expect(fileRowActionHits("unstaged", 26, 10)).toEqual([]);
    expect(
      fileRowActionHits("unstaged", 27, 10).map((hit) => hit.start),
    ).toEqual([11, 18]);
  });
  test("builds shared directories and sorts directories before files", () => {
    const tree = buildFileTree([
      changed("src/z.ts"),
      changed("README.md"),
      changed("src/a.ts", "added"),
    ]);
    expect(tree.children.map((node) => node.name)).toEqual([
      "src",
      "README.md",
    ]);
    expect(tree.children[0]?.kind).toBe("directory");
    if (tree.children[0]?.kind === "directory")
      expect(tree.children[0].children.map((node) => node.name)).toEqual([
        "a.ts",
        "z.ts",
      ]);
  });

  test("expands and collapses by repository-relative path", () => {
    const tree = buildFileTree([changed("src/lib/file with spaces.ts")]);
    let expanded = toggleExpansion(new Set<string>(), "src");
    expect(flattenVisible(tree, expanded).map((row) => row.node.path)).toEqual([
      "src",
      "src/lib",
    ]);
    expanded = toggleExpansion(expanded, "src/lib");
    expect(flattenVisible(tree, expanded).map((row) => row.node.path)).toEqual([
      "src",
      "src/lib",
      "src/lib/file with spaces.ts",
    ]);
  });

  test("propagates the most important status to directories", () => {
    const tree = buildFileTree([
      changed("src/a.ts", "modified"),
      changed("src/b.ts", "conflicted"),
    ]);
    expect(tree.children[0]).toMatchObject({
      kind: "directory",
      status: "conflicted",
    });
  });

  test("fits long names on one row while preserving both ends", () => {
    expect(fitTreeLabel("a-very-long-component.test.ts", 14)).toBe(
      "a-very-l…st.ts",
    );
    expect(fitTreeLabel("short.ts", 14)).toBe("short.ts");
    const wide = fitTreeLabel("界界界界界-file.ts", 10);
    expect(Bun.stringWidth(wide)).toBeLessThanOrEqual(10);
    expect(wide).toContain("…");
  });
});
