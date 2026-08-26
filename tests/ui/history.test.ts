import { describe, expect, test } from "bun:test";
import type { BranchRef } from "../../src/git/types.js";
import {
  branchPresence,
  branchRefsForSection,
  clampBranchSelection,
  filterBranchRefs,
  moveBranchSelection,
  selectedBranchRef,
} from "../../src/ui/history.js";

const refs: BranchRef[] = [
  {
    name: "main",
    fullName: "refs/heads/main",
    sha: "a",
    current: true,
    remote: false,
  },
  {
    name: "feature/sidebar",
    fullName: "refs/heads/feature/sidebar",
    sha: "b",
    current: false,
    remote: false,
  },
  {
    name: "origin/main",
    fullName: "refs/remotes/origin/main",
    sha: "a",
    current: false,
    remote: true,
  },
  {
    name: "upstream/sidebar",
    fullName: "refs/remotes/upstream/sidebar",
    sha: "c",
    current: false,
    remote: true,
  },
];

describe("branch filtering", () => {
  test("returns every ref for an empty or whitespace query", () => {
    expect(filterBranchRefs(refs, "")).toEqual(refs);
    expect(filterBranchRefs(refs, "   ")).toEqual(refs);
    expect(filterBranchRefs(refs, "")).not.toBe(refs);
  });

  test("matches local and remote names case-insensitively", () => {
    expect(filterBranchRefs(refs, "SIDEBAR").map((ref) => ref.name)).toEqual([
      "feature/sidebar",
      "upstream/sidebar",
    ]);
    expect(
      filterBranchRefs(refs, "refs/remotes/origin").map((ref) => ref.name),
    ).toEqual(["origin/main"]);
  });

  test("keeps local and remote rows in their own sections", () => {
    expect(branchRefsForSection(refs, "local").map((ref) => ref.name)).toEqual([
      "main",
      "feature/sidebar",
    ]);
    expect(
      branchRefsForSection(refs, "remote", "sidebar").map((ref) => ref.name),
    ).toEqual(["upstream/sidebar"]);
  });
});

describe("branch keyboard navigation", () => {
  test("clamps selection at both ends and reports no rows as -1", () => {
    expect(clampBranchSelection(-5, 3)).toBe(0);
    expect(clampBranchSelection(99, 3)).toBe(2);
    expect(clampBranchSelection(1, 0)).toBe(-1);
  });

  test("moves within the filtered result without wrapping", () => {
    expect(moveBranchSelection(refs, 0, -1, "sidebar")).toBe(0);
    expect(moveBranchSelection(refs, 0, 1, "sidebar")).toBe(1);
    expect(moveBranchSelection(refs, 1, 1, "sidebar")).toBe(1);
    expect(moveBranchSelection(refs, 0, 1, "missing")).toBe(-1);
  });

  test("resolves stale selections after filtering", () => {
    expect(selectedBranchRef(refs, 20, "sidebar")?.name).toBe(
      "upstream/sidebar",
    );
    expect(selectedBranchRef(refs, -1, "sidebar")).toBeUndefined();
    expect(selectedBranchRef(refs, 0, "missing")).toBeUndefined();
  });
});

describe("branch presence", () => {
  test("recognises a decorated remote name as the same branch", () => {
    expect(branchPresence("origin/main", refs)).toBe("both");
    expect(branchPresence("refs/remotes/origin/main", refs)).toBe("both");
    expect(branchPresence("upstream/sidebar", refs)).toBe("remote");
  });
});
