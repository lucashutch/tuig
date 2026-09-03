import { MouseButton } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import {
  commitRowAtLine,
  historyClick,
  type RuntimeHistoryContext,
} from "../../src/ui/runtime-history.js";

describe("graph row hit testing", () => {
  test("maps each graph line to one commit", () => {
    // No working changes: body line 0 is the first commit.
    expect(commitRowAtLine(0, 0, false)).toBe(0);
    expect(commitRowAtLine(1, 0, false)).toBe(1);
    expect(commitRowAtLine(2, 0, false)).toBe(2);
    expect(commitRowAtLine(3, 0, false)).toBe(3);
  });

  test("skips the working row when it is on screen", () => {
    expect(commitRowAtLine(0, 0, true)).toBe(-1);
    expect(commitRowAtLine(1, 0, true)).toBe(0);
    expect(commitRowAtLine(2, 0, true)).toBe(1);
    expect(commitRowAtLine(3, 0, true)).toBe(2);
  });

  test("keeps scrolled viewports aligned with their first commit", () => {
    // With working changes, scroll offset 1 shows commit 0 at body line 0.
    expect(commitRowAtLine(0, 1, true)).toBe(0);
    expect(commitRowAtLine(1, 1, true)).toBe(1);
    expect(commitRowAtLine(2, 1, true)).toBe(2);
    expect(commitRowAtLine(0, 5, false)).toBe(5);
    expect(commitRowAtLine(3, 5, false)).toBe(8);
  });

  test("rejects clicks above the body", () => {
    expect(commitRowAtLine(-1, 0, false)).toBe(-1);
    expect(commitRowAtLine(-2, 0, true)).toBe(-1);
  });

  test("passes a stash target for clicks away from its label", () => {
    const stash = {
      ref: "stash@{0}",
      sha: "stash-sha",
      createdAt: "now",
      subject: "work in progress",
    };
    const commit = {
      sha: stash.sha,
      parents: [],
      author: "author",
      authorEmail: "author@example.com",
      authoredAt: "now",
      committer: "committer",
      committerEmail: "committer@example.com",
      committedAt: "now",
      subject: stash.subject,
      decorations: [],
    };
    let target: unknown;
    const context = {
      snapshot: {
        files: [],
        commits: [commit],
        stashes: [stash],
      },
      graphRowCount: 1,
      historyStart: 0,
      historySelection: "commit",
      commitIndex: 0,
      historyContentLeft: 10,
      contentHeight: 20,
      pendingScroll: 0,
      historyViewportDetached: false,
      historyShaHits: new Map(),
      historyLabelHits: new Map([[0, { start: 0, end: 4 }]]),
      paneTop: 0,
      doubleClickMs: 300,
      commitDiffVisible: false,
      mode: "unstaged",
      setFocus: () => {},
      paintHistory: () => {},
      paint: () => {},
      closeDiff: () => {},
      openCommit: () => {},
      openGraphMenu: (_x: number, _y: number, menuTarget: unknown) => {
        target = menuTarget;
      },
      checkoutBranch: () => {},
      notify: () => {},
      renderer: undefined,
    } as unknown as RuntimeHistoryContext;

    historyClick(context, 25, 2, MouseButton.RIGHT);

    expect(target).toEqual({ sha: stash.sha, branch: undefined, stash });
  });
});
