import { describe, expect, test } from "bun:test";
import { layoutGraph } from "../../src/ui/graph.js";
import { contextMenu } from "../../src/ui/menu.js";
import {
  branchPresence,
  branchPresenceIcon,
  buildCommitBranchHints,
  formatBranchDecoration,
  resolveHeadSha,
  shortSha,
  summariseDecorations,
} from "../../src/ui/history.js";

describe("UI models", () => {
  test("assigns deterministic graph lanes", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "x",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "b", parents: ["a"] },
        { ...base, sha: "a", parents: [] },
      ],
      ["red"],
    );
    expect(rows.map((row) => row.commit.sha)).toEqual(["b", "a"]);
    expect(rows[0]?.laneColors[0]).toBe("red");
  });
  test("draws a curved split for merge parents", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "merge",
      decorations: [],
    };
    const [row] = layoutGraph(
      [{ ...base, sha: "merge", parents: ["main", "topic"] }],
      ["cyan", "purple"],
    );
    expect(row?.connectors.map((cell) => cell.symbol)).toEqual(["├─", "╮ "]);
  });
  test("fans multiple child lanes into their shared parent", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "commit",
      body: "",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "left", parents: ["root"] },
        { ...base, sha: "right", parents: ["root"] },
        { ...base, sha: "root", parents: [] },
      ],
      ["cyan", "purple"],
    );
    expect(rows[2]?.cells.map((cell) => cell.symbol)).toEqual(["●─", "╯ "]);
  });
  test("joins three sibling lanes with one horizontal fan-in", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "commit",
      body: "",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "one", parents: ["root"] },
        { ...base, sha: "two", parents: ["root"] },
        { ...base, sha: "three", parents: ["root"] },
        { ...base, sha: "root", parents: [] },
      ],
      ["cyan"],
    );
    expect(rows[3]?.cells.map((cell) => cell.symbol)).toEqual([
      "●─",
      "┴─",
      "╯ ",
    ]);
  });
  test("reuses the first lane after an ancestry is exhausted", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "commit",
      body: "",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "branch", parents: ["base"] },
        { ...base, sha: "base", parents: [] },
        { ...base, sha: "new", parents: [] },
      ],
      ["cyan"],
    );
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
  });
  test("marks a horizontal and vertical lane crossing", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "commit",
      body: "",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "left", parents: ["root"] },
        { ...base, sha: "middle", parents: ["other"] },
        { ...base, sha: "right", parents: ["root"] },
        { ...base, sha: "root", parents: [] },
      ],
      ["blue", "yellow", "purple"],
    );
    expect(rows[3]?.cells.map((cell) => cell.symbol)).toEqual([
      "●─",
      "┼─",
      "╯ ",
    ]);
  });
  test("keeps a far-apart ancestry lane continuously colored", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "commit",
      body: "",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "child", parents: ["root"] },
        { ...base, sha: "other-1", parents: ["other-2"] },
        { ...base, sha: "other-2", parents: [] },
        { ...base, sha: "root", parents: [] },
      ],
      ["cyan", "purple"],
    );
    expect(rows[0]?.cells[0]?.color).toBe("cyan");
    expect(rows[1]?.cells[0]?.color).toBe("cyan");
    expect(rows[2]?.cells[0]?.color).toBe("cyan");
    expect(rows[3]?.cells[0]?.color).toBe("cyan");
  });
  test("routes a complex crossing deterministically", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "commit",
      body: "",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "left", parents: ["root"] },
        { ...base, sha: "middle", parents: ["other"] },
        { ...base, sha: "right", parents: ["root"] },
        { ...base, sha: "far", parents: ["third"] },
        { ...base, sha: "root", parents: [] },
      ],
      ["cyan", "purple", "yellow"],
    );
    expect(rows[2]?.connectors.map((cell) => cell.symbol)).toEqual([
      "├─",
      "┼─",
      "┤ ",
    ]);
    expect(rows[4]?.cells.map((cell) => cell.symbol)).toEqual([
      "●─",
      "┼─",
      "╯ ",
      "│ ",
    ]);
  });
  test("merges duplicate lanes before safely reusing their column", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "commit",
      body: "",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "left", parents: ["root"] },
        { ...base, sha: "right", parents: ["root"] },
        { ...base, sha: "root", parents: [] },
        { ...base, sha: "unrelated", parents: [] },
      ],
      ["cyan", "purple"],
    );
    expect(rows.map((row) => row.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[1]?.connectors.map((cell) => cell.symbol)).toEqual([
      "├─",
      "┤ ",
    ]);
    expect(rows[2]?.cells.map((cell) => cell.symbol)).toEqual(["●─", "╯ "]);
    expect(rows[3]?.cells.map((cell) => cell.symbol)).toEqual(["● "]);
  });
  test("marks branch deletion destructive", () =>
    expect(
      contextMenu("branch").items.find((x) => x.action === "delete")
        ?.destructive,
    ).toBe(true));
  test("classifies matching local and remote branches from either ref", () => {
    const refs = [
      {
        name: "main",
        fullName: "refs/heads/main",
        sha: "a",
        current: true,
        remote: false,
      },
      {
        name: "origin/main",
        fullName: "refs/remotes/origin/main",
        sha: "a",
        current: false,
        remote: true,
      },
    ];
    expect(branchPresence(refs[0]!, refs)).toBe("both");
    expect(branchPresence(refs[1]!, refs)).toBe("both");
    expect(branchPresenceIcon("both", true)).toBe("◉");
    expect(shortSha("1234567890")).toBe("12345678");
  });
  test("formats graph branches with local and remote device markers", () => {
    const refs = [
      {
        name: "main",
        fullName: "refs/heads/main",
        sha: "a",
        current: true,
        remote: false,
      },
      {
        name: "topic",
        fullName: "refs/heads/topic",
        sha: "b",
        current: false,
        remote: false,
      },
      {
        name: "origin/review",
        fullName: "refs/remotes/origin/review",
        sha: "c",
        current: false,
        remote: true,
      },
      {
        name: "origin/main",
        fullName: "refs/remotes/origin/main",
        sha: "a",
        current: false,
        remote: true,
      },
    ];
    expect(formatBranchDecoration("main", refs)).toBe("󰌢 󰖟 main");
    expect(formatBranchDecoration("topic", refs)).toBe("󰌢 topic");
    expect(formatBranchDecoration("origin/review", refs)).toBe("󰖟 review");
    expect(formatBranchDecoration("origin/main", refs)).toBe("󰌢 󰖟 main");
    expect(formatBranchDecoration("HEAD -> main", refs)).toBe("◉ 󰖟 main");
    expect(formatBranchDecoration("HEAD -> topic", refs)).toBe("◉ topic");
  });
  test("marks the checked-out commit in the graph", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "x",
      decorations: [],
    };
    const rows = layoutGraph(
      [
        { ...base, sha: "b", parents: ["a"] },
        { ...base, sha: "a", parents: [] },
      ],
      ["red"],
      "a",
    );
    expect(rows.map((row) => row.head)).toEqual([false, true]);
    expect(rows.map((row) => row.cells[0]?.symbol)).toEqual(["● ", "◉ "]);
  });
  test("resolves HEAD from the current branch even when another branch is newer", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "x",
      parents: [],
    };
    const commits = [
      { ...base, sha: "newer-other-branch", decorations: [] },
      { ...base, sha: "current-head", decorations: ["HEAD"] },
    ];
    expect(resolveHeadSha([], commits)).toBe("current-head");
    expect(
      resolveHeadSha(
        [
          {
            name: "main",
            fullName: "refs/heads/main",
            sha: "current-head",
            current: true,
            remote: false,
          },
        ],
        commits,
      ),
    ).toBe("current-head");
    expect(resolveHeadSha([], [{ ...base, sha: "a", decorations: [] }])).toBe(
      undefined,
    );
  });
  test("labels an ancestor with its nearest branch without implying a tip", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
      committer: "Test Committer",
      committerEmail: "committer@example.com",
      committedAt: "2026-01-01",
      subject: "x",
      body: "",
      decorations: [],
    };
    const hints = buildCommitBranchHints(
      [
        { ...base, sha: "tip", parents: ["middle"] },
        { ...base, sha: "middle", parents: ["root"] },
        { ...base, sha: "root", parents: [] },
      ],
      [
        {
          name: "main",
          fullName: "refs/heads/main",
          sha: "tip",
          current: true,
          remote: false,
        },
      ],
    );
    expect(hints.get("middle")).toBe("↳ 󰌢 main");
  });
});

describe("decoration summaries", () => {
  const refs = [
    {
      name: "main",
      fullName: "refs/heads/main",
      sha: "a",
      current: true,
      remote: false,
    },
    {
      name: "origin/main",
      fullName: "refs/remotes/origin/main",
      sha: "a",
      current: false,
      remote: true,
    },
  ];

  test("keeps the primary ref and counts the rest", () => {
    const summary = summariseDecorations(
      ["HEAD -> main", "origin/main", "tag: v1.2.0"],
      refs,
    );
    expect(summary.label).toContain("main");
    // The local and remote ref for main are one branch, plus the tag.
    expect(summary.extra).toBe(1);
  });

  test("counts a genuinely separate branch", () => {
    const summary = summariseDecorations(
      ["HEAD -> main", "origin/main", "release", "tag: v1.2.0"],
      refs,
    );
    expect(summary.label).toContain("main");
    expect(summary.extra).toBe(2);
  });

  test("shows a tag when a commit has no branch decoration", () => {
    const summary = summariseDecorations(["tag: v1.2.0"], refs);
    expect(summary.label).toContain("v1.2.0");
    expect(summary.extra).toBe(0);
  });

  test("reports nothing for an undecorated commit", () => {
    expect(summariseDecorations([], refs)).toEqual({ label: "", extra: 0 });
  });
});
