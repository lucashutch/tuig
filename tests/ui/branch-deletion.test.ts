import { expect, test } from "bun:test";
import type { BranchRef } from "../../src/git/types.js";
import { branchDeletionCopies } from "../../src/ui/branch-deletion.js";

const local: BranchRef = {
  name: "topic",
  fullName: "refs/heads/topic",
  sha: "a",
  remote: false,
  current: false,
};
const remote = (name: string): BranchRef => ({
  name,
  fullName: `refs/remotes/${name}`,
  sha: "b",
  remote: true,
  current: false,
});

test("uses the configured upstream even when its branch name differs", () => {
  const branch = { ...local, upstream: "other/renamed" };
  const upstream = remote("other/renamed");
  const refs = [branch, remote("origin/topic"), upstream];
  expect(branchDeletionCopies(branch, refs)).toEqual({
    local: branch,
    remote: upstream,
  });
  expect(branchDeletionCopies(upstream, refs)).toEqual({
    local: branch,
    remote: upstream,
  });
});

test("does not guess a remote or substitute for a missing upstream", () => {
  const refs = [local, remote("origin/topic"), remote("other/topic")];
  expect(branchDeletionCopies(local, refs).remote).toBeUndefined();
  expect(
    branchDeletionCopies({ ...local, upstream: "missing/topic" }, refs).remote,
  ).toBeUndefined();
});

test("does not pair a local branch with a remote branch that only shares its suffix", () => {
  expect(
    branchDeletionCopies(local, [local, remote("origin/feature/topic")]).remote,
  ).toBeUndefined();
});
