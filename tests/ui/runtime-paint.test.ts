import { describe, expect, test } from "bun:test";
import type {
  ChangedFile,
  Commit,
  RepositorySnapshot,
} from "../../src/git/types.js";
import {
  layoutGraph,
  packGraphRow,
  type GraphRow,
} from "../../src/ui/graph.js";
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
  rows: GraphRow[];
  graphVisibleColumns: number;
  requests: number;
  text: string;
  historyText: { visible: boolean };
};

/** A history pane of `viewport` rows scrolled to `historyStart`. */
function paintContext(
  commits: Commit[],
  options: {
    complete: boolean;
    historyStart: number;
    viewport: number;
    files?: ChangedFile[];
  },
): Painted {
  const snapshot = {
    root: "/repo",
    branch: "main",
    ahead: 0,
    behind: 0,
    files: options.files ?? [],
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
    // The runtime replays these from lane checkpoints; a stub can just hold
    // them, since what is painted is the window it hands back.
    rows: layoutGraph(commits, oneDarkTheme.graph) as GraphRow[],
    get graphRowCount() {
      return context.rows.length;
    },
    graphRowsAt(from: number, count: number): readonly GraphRow[] {
      return context.rows.slice(from, from + count);
    },
    graphColumns: 1,
    graphScroll: 0,
    setGraphScroll(value: number) {
      context.graphScroll = value;
    },
    setGraphVisibleColumns(value: number) {
      context.graphVisibleColumns = value;
    },
    graphVisibleColumns: 1,
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

/** Give every row `columns` lanes, as a repository with many branches would. */
function widen(context: Painted, columns: number) {
  context.graphColumns = columns;
  context.rows = context.rows.map((row) => {
    const cells = Array.from({ length: columns }, (_, index) => ({
      symbol: index === row.lane ? "● " : "│ ",
      color: "#ffffff",
    }));
    return packGraphRow({
      commit: row.commit,
      lane: row.lane,
      head: row.head,
      continuesAbove: row.continuesAbove,
      cells,
      connectors: cells,
    });
  });
}

describe("wide graphs", () => {
  test("caps the graph and marks the lanes it hides", () => {
    const context = paintContext(history(5), {
      complete: true,
      historyStart: 0,
      viewport: 10,
    });
    widen(context, 40);
    paintHistory(context);
    expect(context.graphVisibleColumns).toBe(16);
    expect(context.text).toContain(" ▸");
    const line = context.text.split("\n")[1]!;
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(
      context.historyContentWidth,
    );
    expect(line).toContain("commit 0");
  });

  test("panning reveals the lanes on the right", () => {
    const context = paintContext(history(5), {
      complete: true,
      historyStart: 0,
      viewport: 10,
    });
    widen(context, 40);
    context.graphScroll = 100;
    paintHistory(context);
    // Clamped to the last window, which hides lanes only on the left.
    expect(context.graphScroll).toBe(24);
    // The graph window sits after the 22-column label and the selection mark.
    const graph = context.text.split("\n")[1]!.slice(24, 24 + 16 * 2);
    expect(graph).toContain("◂ ");
    expect(graph).not.toContain("▸");
  });
});

describe("the working row and the graph window", () => {
  const working: ChangedFile[] = [
    { path: "a.txt", state: "modified", staged: false, unstaged: true },
  ];

  test("paints the commits below a working row scrolled off the top", () => {
    // The working row shifts every commit down one line, so the window the
    // paint asks for starts one behind the first unit on screen. Scrolled
    // past it, that offset is the only thing keeping the rows aligned.
    const context = paintContext(history(40), {
      complete: true,
      historyStart: 12,
      viewport: 6,
      files: working,
    });
    paintHistory(context);
    expect(context.text).not.toContain("Working changes");
    // Unit 12 is commit 11, since the working row is unit 0.
    expect(context.text).toContain("commit 11");
    expect(context.text).toContain("commit 16");
    expect(context.text).not.toContain("commit 10");
    expect(context.text).not.toContain("commit 17");
  });

  test("paints the working row above the first commit", () => {
    const context = paintContext(history(40), {
      complete: true,
      historyStart: 0,
      viewport: 6,
      files: working,
    });
    paintHistory(context);
    const lines = context.text.split("\n");
    expect(lines[1]).toContain("Working changes");
    expect(lines[2]).toContain("commit 0");
    expect(context.text).toContain("commit 4");
    expect(context.text).not.toContain("commit 5");
  });
});
