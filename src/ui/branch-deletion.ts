import type { BranchRef } from "../git/types.js";

/** Resolve a single counterpart, never guess between multiple remotes. */
export function branchDeletionCopies(
  branch: BranchRef,
  refs: readonly BranchRef[],
) {
  const locals = refs.filter((ref) => !ref.remote);
  const remotes = refs.filter((ref) => ref.remote);
  const remoteFor = (local: BranchRef) => {
    if (local.upstream)
      return remotes.find(
        (ref) => ref.name === local.upstream || ref.fullName === local.upstream,
      );
    const matches = remotes.filter(
      (ref) => ref.name.slice(ref.name.indexOf("/") + 1) === local.name,
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  if (!branch.remote) return { local: branch, remote: remoteFor(branch) };
  const matches = locals.filter(
    (local) => remoteFor(local)?.fullName === branch.fullName,
  );
  return {
    local: matches.length === 1 ? matches[0] : undefined,
    remote: branch,
  };
}
