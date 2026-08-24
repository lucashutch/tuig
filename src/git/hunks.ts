export interface DiffHunk {
  index: number;
  header: string;
  patch: string;
}

/** Splits a one-file unified Git diff into independently applicable patches. */
export function splitPatchHunks(patch: string): DiffHunk[] {
  const first = patch.search(/^@@ /m);
  if (first < 0) return [];
  const preamble = patch.slice(0, first);
  const body = patch.slice(first);
  const starts = [...body.matchAll(/^@@ /gm)].map((match) => match.index ?? 0);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? body.length;
    const section = body.slice(start, end);
    return {
      index,
      header: section.split("\n", 1)[0] ?? "@@",
      patch: preamble + section,
    };
  });
}
