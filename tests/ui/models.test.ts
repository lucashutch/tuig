import { describe, expect, test } from "bun:test";
import { layoutGraph } from "../../src/ui/graph.js";
import { contextMenu } from "../../src/ui/menu.js";
import {
  branchPresence,
  branchPresenceIcon,
  buildCommitBranchHints,
  formatBranchDecoration,
  shortSha,
} from "../../src/ui/history.js";

describe("UI models", () => {
  test("assigns deterministic graph lanes", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
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
      "──",
      "╯ ",
    ]);
  });
  test("reuses the first lane after an ancestry is exhausted", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
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
  });
  test("labels an ancestor with its nearest branch without implying a tip", () => {
    const base = {
      author: "A",
      authorEmail: "a@b",
      authoredAt: "2026-01-01",
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
