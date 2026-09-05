import { describe, expect, test } from "bun:test";
import {
  loadDiff,
  type RuntimeDataContext,
} from "../../src/ui/runtime-data.js";
import {
  createDiffSyntaxStyle,
  diffSyntaxStyles,
} from "../../src/ui/diff-syntax.js";

describe("diff syntax highlighting", () => {
  test("uses distinct token colors without hiding diff backgrounds", () => {
    const style = createDiffSyntaxStyle();
    try {
      expect(style.resolveStyleId("keyword")).not.toBeNull();
      expect(diffSyntaxStyles.keyword!.fg).not.toBe(
        diffSyntaxStyles.string!.fg,
      );
      for (const token of Object.values(diffSyntaxStyles)) {
        expect(token.bg).toBeUndefined();
      }
    } finally {
      style.destroy();
    }
  });

  for (const view of ["working", "commit"]) {
    test(`${view} diffs select and reset the language when switching files`, async () => {
      let path: string | undefined = "src/example.ts";
      const diff = { diff: "", filetype: undefined as string | undefined };
      const context = {
        diffRequest: 0,
        commitIndex: 0,
        view,
        mode: "staged",
        snapshot: { commits: [{ sha: "abc" }] },
        selectedFile: () => (path ? { path } : undefined),
        repository: { diff: async () => "patch" },
        widgets: { commitDiff: diff, commitDiffEmpty: { visible: false } },
      } as unknown as RuntimeDataContext;

      await loadDiff(context);
      expect(diff.filetype).toBe("typescript");
      expect(diff.diff).toBe("patch");
      path = "src/example.py";
      await loadDiff(context);
      expect(diff.filetype).toBe("python");
      path = "data.unknown-extension";
      await loadDiff(context);
      expect(diff.filetype).toBeUndefined();
      path = undefined;
      await loadDiff(context);
      expect(diff.filetype).toBeUndefined();
    });
  }

  test("a stale diff cannot replace the current language", async () => {
    let resolve!: (value: string) => void;
    let path = "old.ts";
    const diff = { diff: "current", filetype: "python" };
    const context = {
      diffRequest: 0,
      view: "working",
      mode: "unstaged",
      selectedFile: () => ({ path }),
      repository: {
        diff: () => new Promise<string>((done) => (resolve = done)),
      },
      widgets: { commitDiff: diff, commitDiffEmpty: { visible: false } },
    } as unknown as RuntimeDataContext;
    const pending = loadDiff(context);
    path = "current.py";
    resolve("stale");
    await pending;
    expect(diff).toEqual({ diff: "current", filetype: "python" });
  });
});
