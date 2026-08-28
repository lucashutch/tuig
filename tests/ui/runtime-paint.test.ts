import { describe, expect, test } from "bun:test";
import type { Commit, RepositorySnapshot } from "../../src/git/types.js";
import { layoutGraph } from "../../src/ui/graph.js";
import {
  paintHistory,
  type RuntimePaintContext,
} from "../../src/ui/runtime-paint.js";
import { oneDarkTheme } from "../../src/ui/theme.js";

function history(length: number): Commit[] {
  return Array.from({ length }, (_, index) => ({
    sha: `c${index}`,
    parents: index + 1 < length ? [`c${index + 1}`] : [],
    author: "Test User",
    authorEmail: "test@example.com",
    authoredAt: "2020-01-01T00:00:00+00:00",
    committer: "Test User",
    committerEmail: "test@example.com",
    committedAt: "2020-01-01T00:00:00+00:00",
    subject: `commit ${index}`,
    decorations: [],
  }));
}

type Painted = RuntimePaintContext & {
  requests: number;
  text: string;
  historyText: { visible: boolean };
};

/** A history pane of `viewport` rows scrolled to `historyStart`. */
function paintContext(
  commits: Commit[],
  options: { complete: boolean; historyStart: number; viewport: number },
): Painted {
  const snapshot = {
    root: "/repo",
    branch: "main",
    ahead: 0,
    behind: 0,
    files: [],
    branches: [],
    stashes: [],
    worktrees: [],
    submodules: [],
    commits,
    commitsComplete: options.complete,
  } satisfies RepositorySnapshot;
  const context = {
    requests: 0,
    text: "",
    snapshot,
    // paintHistory reserves three rows of chrome.
    contentHeight: options.viewport + 3,
    focus: "history",
    graphRows: layoutGraph(commits, oneDarkTheme.graph),
    graphColumns: 1,
    branchHints: new Map<string, string>(),
    historySelection: "commit",
    commitIndex: 0,
    historyStart: options.historyStart,
    setHistoryStart(value: number) {
      context.historyStart = value;
    },
    historyViewportDetached: true,
    historyContentWidth: 120,
    historyShaHits: new Map(),
    historyLabelHits: new Map(),
    historyText: {
      visible: true,
      set content(value: { chunks: Array<{ text: string }> }) {
        context.text = value.chunks.map((chunk) => chunk.text).join("");
      },
    },
    requestMoreCommits() {
      context.requests++;
    },
    commitDiffVisible: false,
    updateGraphAvatars() {},
  };
  return context as unknown as Painted;
}

describe("history prefetch", () => {
  test("hides history text behind an open commit diff", () => {
    const context = paintContext(history(10), {
      complete: true,
      historyStart: 0,
      viewport: 40,
    });
    context.commitDiffVisible = true;
    paintHistory(context);
    expect(context.historyText.visible).toBe(false);

    context.commitDiffVisible = false;
    paintHistory(context);
    expect(context.historyText.visible).toBe(true);
  });

  test("asks for more history once the end is nearly in view", () => {
    const commits = history(250);
    // 40 rows visible ending at row 240, so ten rows remain below.
    const near = paintContext(commits, {
      complete: false,
      historyStart: 200,
      viewport: 40,
    });
    paintHistory(near);
    expect(near.requests).toBe(1);
  });

  test("does not ask while the end is still far below", () => {
    const far = paintContext(history(250), {
      complete: false,
      historyStart: 0,
      viewport: 40,
    });
    paintHistory(far);
    expect(far.requests).toBe(0);
  });

  test("does not ask once all history is loaded", () => {
    const complete = paintContext(history(250), {
      complete: true,
      historyStart: 200,
      viewport: 40,
    });
    paintHistory(complete);
    expect(complete.requests).toBe(0);
  });

  test("asks when the loaded history is shorter than the viewport", () => {
    const short = paintContext(history(10), {
      complete: false,
      historyStart: 0,
      viewport: 40,
    });
    paintHistory(short);
    expect(short.requests).toBe(1);
  });

  test("marks the count as partial only while history is incomplete", () => {
    const partial = paintContext(history(250), {
      complete: false,
      historyStart: 0,
      viewport: 40,
    });
    paintHistory(partial);
    expect(partial.text).toContain("250+ COMMITS");
    const whole = paintContext(history(250), {
      complete: true,
      historyStart: 0,
      viewport: 40,
    });
    paintHistory(whole);
    expect(whole.text).toContain("250 COMMITS");
    expect(whole.text).not.toContain("250+");
  });
});
