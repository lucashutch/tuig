import { expect, mock, test } from "bun:test";
import {
  filesClick,
  type RuntimeFilesContext,
} from "../../src/ui/runtime-files.js";

for (const section of ["unstaged", "staged"] as const) {
  test(`clicking a ${section} file in a working diff keeps its working origin`, () => {
    const openWorkingDiff = mock(async () => {});
    const loadDiff = mock(async () => {});
    const context = {
      view: "working",
      mode: "unstaged",
      diffOrigin: "working",
      snapshot: {
        files: [
          { path: "a.txt", staged: true, unstaged: true, state: "modified" },
          { path: "b.txt", staged: true, unstaged: true, state: "modified" },
        ],
      },
      fileIndex: 0,
      fileStart: 0,
      sectionStart: { staged: 0, unstaged: 0 },
      expandedFiles: new Set<string>(),
      widgets: {
        unstagedText: { top: 3, y: 7 },
        stagedText: { top: 12, y: 16 },
      },
      sectionViewport: () => 10,
      setFocus: () => {},
      paintFiles: () => {},
      openWorkingDiff,
      loadDiff,
    } as unknown as RuntimeFilesContext;

    const list =
      context.widgets[section === "staged" ? "stagedText" : "unstagedText"];
    filesClick(context, section, list.y + 1);

    expect(context.fileIndex).toBe(1);
    expect(context.mode).toBe(section);
    expect(context.diffOrigin).toBe("working");
    expect(openWorkingDiff).toHaveBeenCalledTimes(1);
    expect(loadDiff).not.toHaveBeenCalled();
  });
}

for (const view of ["history", "working", "commit"] as const) {
  for (const start of [0, 1]) {
    test(`${view} file clicks use screen coordinates with scroll offset ${start}`, () => {
      const changedFiles = ["a.txt", "b.txt", "c.txt"].map((path) => ({
        path,
        staged: false,
        unstaged: true,
        state: "modified",
      }));
      const openFileMenu = mock(() => {});
      const context = {
        view,
        mode: "unstaged",
        snapshot: { files: changedFiles },
        commitFiles: changedFiles,
        fileIndex: 0,
        fileStart: start,
        sectionStart: { unstaged: start, staged: 0 },
        expandedFiles: new Set<string>(),
        widgets: {
          unstagedText: { top: 5, y: 8 },
          commitDiff: { visible: false },
          commitDiffEmpty: { visible: false },
        },
        sectionViewport: () => 2,
        setFocus: () => {},
        paintFiles: () => {},
        layout: () => {},
        openWorkingDiff: async () => {},
        loadDiff: async () => {},
        openFileMenu,
      } as unknown as RuntimeFilesContext;

      filesClick(context, "unstaged", 8);
      expect(context.fileIndex).toBe(start);
      filesClick(context, "unstaged", 9);
      expect(context.fileIndex).toBe(start + 1);

      if (view === "history") {
        filesClick(context, "unstaged", 8, 2, 42);
        expect(openFileMenu).toHaveBeenCalledWith(42, 8, {
          sha: "",
          file: changedFiles[start],
          fileStaged: false,
        });
      }
    });
  }
}
