import { expect, mock, test } from "bun:test";
import type { ChangedFile } from "../../src/git/types.js";
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

test("inline actions require the clicked row to be visibly hovered", () => {
  const runFileAction = mock(
    (
      action: "stage" | "discard" | "unstage",
      files: ChangedFile[],
      directory: boolean,
    ) => void [action, files, directory],
  );
  const changedFiles = ["a.txt", "b.txt"].map((path) => ({
    path,
    staged: false,
    unstaged: true,
    state: "modified" as const,
  }));
  const context = {
    view: "history",
    mode: "unstaged",
    snapshot: { files: changedFiles },
    fileIndex: 0,
    fileStart: 0,
    sectionStart: { unstaged: 0, staged: 0 },
    expandedFiles: new Set<string>(),
    hoveredFileRow: { section: "unstaged", row: 0 },
    widgets: { unstagedText: { x: 10, y: 8, width: 30 } },
    sectionViewport: () => 2,
    setFocus: () => {},
    paintFiles: () => {},
    openWorkingDiff: async () => {},
    runFileAction,
  } as unknown as RuntimeFilesContext;

  // Column 24 is Stage only when the measured 30-column list starts at 10.
  filesClick(context, "unstaged", 9, 0, 24);
  expect(runFileAction).not.toHaveBeenCalled();
  filesClick(context, "unstaged", 8, 0, 24);
  expect(runFileAction).toHaveBeenCalledTimes(1);
  expect(runFileAction.mock.calls[0]?.[0]).toBe("stage");
  expect(runFileAction.mock.calls[0]?.[1]).toEqual([
    expect.objectContaining(changedFiles[0]!),
  ]);
  expect(runFileAction.mock.calls[0]?.[2]).toBe(false);
});

test("inline action columns do nothing in commit view", () => {
  const runFileAction = mock(
    (
      action: "stage" | "discard" | "unstage",
      files: ChangedFile[],
      directory: boolean,
    ) => void [action, files, directory],
  );
  const file = {
    path: "a.txt",
    staged: false,
    unstaged: true,
    state: "modified" as const,
  };
  const context = {
    view: "commit",
    mode: "unstaged",
    commitFiles: [file],
    fileIndex: 0,
    fileStart: 0,
    sectionStart: { unstaged: 0, staged: 0 },
    expandedFiles: new Set<string>(),
    hoveredFileRow: { section: "unstaged", row: 0 },
    widgets: {
      unstagedText: { x: 10, y: 8, width: 30 },
      commitDiff: { visible: false },
      commitDiffEmpty: { visible: false },
    },
    sectionViewport: () => 2,
    setFocus: () => {},
    paintFiles: () => {},
    layout: () => {},
    loadDiff: async () => {},
    runFileAction,
  } as unknown as RuntimeFilesContext;

  filesClick(context, "unstaged", 8, 0, 24);
  expect(runFileAction).not.toHaveBeenCalled();
});

test("deep rows only hit actions when painting has room for the tree prefix", () => {
  const runFileAction = mock(() => {});
  const context = {
    view: "history",
    mode: "unstaged",
    snapshot: {
      files: [
        {
          path: "one/two/file.txt",
          staged: false,
          unstaged: true,
          state: "modified",
        },
      ],
    },
    fileIndex: 0,
    fileStart: 0,
    sectionStart: { unstaged: 0, staged: 0 },
    expandedFiles: new Set(["one", "one/two"]),
    hoveredFileRow: { section: "unstaged", row: 2 },
    widgets: { unstagedText: { x: 0, y: 0, width: 26 } },
    sectionViewport: () => 4,
    setFocus: () => {},
    paintFiles: () => {},
    openWorkingDiff: async () => {},
    runFileAction,
  } as unknown as RuntimeFilesContext;

  filesClick(context, "unstaged", 2, 0, 12);
  expect(runFileAction).not.toHaveBeenCalled();
  context.widgets.unstagedText.width = 27;
  filesClick(context, "unstaged", 2, 0, 12);
  expect(runFileAction).toHaveBeenCalledWith(
    "stage",
    [expect.objectContaining({ path: "one/two/file.txt" })],
    false,
  );
});

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
