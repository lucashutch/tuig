import { describe, expect, test } from "bun:test";
import type { BranchRef, Commit } from "../../src/git/types.js";
import {
  branchPresence,
  branchPresenceFromIndex,
  branchRefsForSection,
  buildBranchPresenceIndex,
  branchHints,
  buildCommitBranchHints,
  emptyBranchHintIndex,
  extendCommitBranchHints,
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

describe("branch presence index", () => {
  const indexed = (name: string | (typeof refs)[number]) =>
    branchPresenceFromIndex(name, buildBranchPresenceIndex(refs));

  test("resolves every input shape the same way as the scanning path", () => {
    const inputs: Array<string | (typeof refs)[number]> = [
      ...refs,
      "main",
      "origin/main",
      "refs/heads/main",
      "refs/remotes/origin/main",
      "upstream/sidebar",
      "refs/remotes/upstream/sidebar",
      "feature/nested/name",
      "refs/heads/feature/nested/name",
      "unknown-remote/main",
      "missing",
      "",
    ];
    for (const input of inputs)
      expect([input, indexed(input)]).toEqual([
        input,
        branchPresence(input, refs),
      ]);
  });

  test("keeps a slashed local name distinct from a remote prefix", () => {
    expect(branchPresence("feature/nested/name", refs)).toBe(
      indexed("feature/nested/name"),
    );
    expect(branchPresence("unknown-remote/main", refs)).toBe("none");
  });
});

const base = {
  author: "A",
  authorEmail: "a@b",
  authoredAt: "2026-01-01",
  committer: "C",
  committerEmail: "c@d",
  committedAt: "2026-01-01",
  subject: "x",
  body: "",
  decorations: [] as string[],
};
const commit = (sha: string, parents: string[]): Commit => ({
  ...base,
  sha,
  parents,
});
const ref = (
  name: string,
  sha: string,
  extra: Partial<BranchRef> = {},
): BranchRef => ({
  name,
  fullName: name.includes("/") ? `refs/remotes/${name}` : `refs/heads/${name}`,
  sha,
  current: false,
  remote: name.includes("/"),
  ...extra,
});
describe("commit branch hints", () => {
  const chain = [
    commit("a", ["b"]),
    commit("b", ["c"]),
    commit("c", ["d"]),
    commit("d", []),
  ];

  test("labels an ancestor with the nearest ref, not a distant one", () => {
    const hints = buildCommitBranchHints(chain, [
      ref("far", "a"),
      ref("near", "c"),
    ]);
    expect(hints.get("c")).toBe("↳ 󰌢 near");
    expect(hints.get("d")).toBe("↳ 󰌢 near");
    expect(hints.get("b")).toBe("↳ 󰌢 far");
  });

  test("prefers current over local over remote at the same distance", () => {
    const tips = [
      ref("origin/main", "a"),
      ref("local", "a"),
      ref("head", "a", { current: true }),
    ];
    expect(buildCommitBranchHints(chain, tips).get("b")).toBe("↳ 󰌢 head");
    expect(buildCommitBranchHints(chain, tips.slice(0, 2)).get("b")).toBe(
      "↳ 󰌢 local",
    );
    expect(buildCommitBranchHints(chain, tips.slice(0, 1)).get("b")).toBe(
      "↳ 󰖟 main",
    );
  });

  test("breaks a distance and priority tie by ref order", () => {
    const hints = buildCommitBranchHints(chain, [
      ref("first", "a"),
      ref("second", "a"),
    ]);
    expect(hints.get("b")).toBe("↳ 󰌢 first");
  });

  test("walks both parents of a merge commit", () => {
    const hints = buildCommitBranchHints(
      [
        commit("merge", ["left", "right"]),
        commit("left", ["root"]),
        commit("right", ["root"]),
        commit("root", []),
      ],
      [ref("main", "merge", { current: true })],
    );
    expect(hints.get("left")).toBe("↳ 󰌢 main");
    expect(hints.get("right")).toBe("↳ 󰌢 main");
    expect(hints.get("root")).toBe("↳ 󰌢 main");
  });

  test("keeps a ref whose tip is outside the loaded commits", () => {
    const hints = buildCommitBranchHints(chain, [ref("detached", "unloaded")]);
    expect(hints.get("unloaded")).toBe("↳ 󰌢 detached");
    expect(hints.has("a")).toBe(false);
  });

  test("returns nothing without refs", () => {
    expect(buildCommitBranchHints(chain, []).size).toBe(0);
  });
});

describe("incremental branch hints", () => {
  /** Deterministic pseudo-random source, so a failure is reproducible. */
  function random(seed: number) {
    let state = seed;
    return () =>
      (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  }

  /** A random newest-first DAG, with merges and refs at arbitrary depths. */
  function randomHistory(next: () => number) {
    const size = 5 + Math.floor(next() * 60);
    const commits: Commit[] = [];
    for (let index = 0; index < size; index++) {
      const parents: string[] = [];
      const count = next() < 0.2 ? 2 : 1;
      for (let n = 0; n < count; n++) {
        const at = index + 1 + Math.floor(next() * 6);
        if (at < size && !parents.includes(`c${at}`)) parents.push(`c${at}`);
      }
      commits.push(commit(`c${index}`, parents));
    }
    const refs: BranchRef[] = [];
    const refCount = 1 + Math.floor(next() * 5);
    for (let n = 0; n < refCount; n++)
      refs.push({
        ...ref(`r${n}`, `c${Math.floor(next() * size)}`),
        current: n === 0 && next() < 0.5,
        remote: next() < 0.4,
      });
    return { commits, refs, page: 1 + Math.floor(next() * 10) };
  }

  test("paging in reaches the same hints as one whole-history pass", () => {
    const next = random(1);
    for (let trial = 0; trial < 200; trial++) {
      const { commits, refs, page } = randomHistory(next);
      let index = emptyBranchHintIndex();
      for (let at = 0; at < commits.length; at += page)
        index = extendCommitBranchHints(
          index,
          commits.slice(at, at + page),
          refs,
        );
      expect([...branchHints(index)].sort()).toEqual(
        [...buildCommitBranchHints(commits, refs)].sort(),
      );
    }
  });

  test("a later page can shorten a hint already assigned", () => {
    // "near" points at a commit that pages in late, which git can do when
    // commit dates disagree with topology. Until it lands, the only route to
    // c is the long one from "far".
    const refs = [ref("far", "a"), ref("near", "t")];
    let index = extendCommitBranchHints(
      emptyBranchHintIndex(),
      [commit("a", ["b"]), commit("b", ["c"]), commit("c", [])],
      refs,
    );
    expect(branchHints(index).get("c")).toBe("↳ 󰌢 far");
    index = extendCommitBranchHints(index, [commit("t", ["c"])], refs);
    expect(branchHints(index).get("c")).toBe("↳ 󰌢 near");
  });

  test("restarts against every commit loaded, not just the new page", () => {
    // The restart must keep the commits it already has. Searching a graph
    // holding only the page it was handed would drop hints already on screen.
    let index = extendCommitBranchHints(
      emptyBranchHintIndex(),
      [commit("a", ["b"]), commit("b", ["d"])],
      [ref("old", "a")],
    );
    index = extendCommitBranchHints(
      index,
      [commit("d", [])],
      [ref("new", "a")],
    );
    const hints = branchHints(index);
    expect(hints.get("a")).toBe("↳ 󰌢 new");
    expect(hints.get("b")).toBe("↳ 󰌢 new");
    expect(hints.get("d")).toBe("↳ 󰌢 new");
  });
});
