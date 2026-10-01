export type DiffLineTarget = {
  /** One-based line number in the selected side of the file. */
  line: number;
  side: "old" | "new";
  kind: "context" | "added" | "removed";
  oldLine?: number;
  /** Zero-based row in the raw unified patch. */
  rawRow: number;
  /** Zero-based body row used by OpenTUI's unified DiffRenderable. */
  renderedRow: number;
};

/**
 * Map a zero-based rendered unified-diff row to a file line.
 *
 * Callers should render without wrapping so one terminal row remains one diff
 * row. Headers and no-newline markers intentionally have no target.
 */
export function diffLineTarget(
  diff: string,
  row: number,
): DiffLineTarget | undefined {
  if (row < 0) return undefined;
  const lines = diff.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let renderedRow = 0;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]!;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || text.startsWith("\\")) continue;
    const oldAt = oldLine;
    const newAt = newLine;
    if (text.startsWith("-")) oldLine++;
    else if (text.startsWith("+")) newLine++;
    else {
      oldLine++;
      newLine++;
    }
    const currentRenderedRow = renderedRow++;
    if (index !== row) continue;
    if (text.startsWith("-"))
      return {
        line: oldAt,
        side: "old",
        kind: "removed",
        oldLine: oldAt,
        rawRow: index,
        renderedRow: currentRenderedRow,
      };
    if (text.startsWith("+"))
      return {
        line: newAt,
        side: "new",
        kind: "added",
        rawRow: index,
        renderedRow: currentRenderedRow,
      };
    return {
      line: newAt,
      side: "new",
      kind: "context",
      oldLine: oldAt,
      rawRow: index,
      renderedRow: currentRenderedRow,
    };
  }
  return undefined;
}

/** Map a DiffRenderable body row, using its public per-hunk row offsets. */
export function renderedDiffLineTarget(
  diff: string,
  row: number,
  hunkOffsets: readonly number[],
): DiffLineTarget | undefined {
  const lines = diff.split("\n");
  const hunks: string[][] = [];
  for (const text of lines) {
    if (text.startsWith("@@ ")) hunks.push([]);
    else if (
      hunks.length &&
      !text.startsWith("diff --git ") &&
      !text.startsWith("\\ No newline at end of file")
    )
      hunks.at(-1)!.push(text);
  }
  for (let hunk = 0; hunk < hunkOffsets.length; hunk++) {
    const bodyRow = row - hunkOffsets[hunk]!;
    const body = hunks[hunk];
    if (!body || bodyRow < 0 || bodyRow >= body.length) continue;
    let rawRow = 0;
    let seen = -1;
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]!.startsWith("@@ ")) seen++;
      if (seen === hunk) {
        const header = lines[index]!.startsWith("@@ ");
        if (
          !header &&
          !lines[index]!.startsWith("\\ No newline at end of file") &&
          rawRow++ === bodyRow
        )
          return diffLineTarget(diff, index);
      }
    }
  }
  return undefined;
}

/** Map one side of an aligned split-diff row back to the unified patch. */
export function splitDiffLineTarget(
  diff: string,
  row: number,
  side: "old" | "new",
): DiffLineTarget | undefined {
  if (row < 0) return undefined;
  const lines = diff.split("\n");
  let logicalRow = 0;
  let inHunk = false;
  for (let index = 0; index < lines.length; ) {
    const text = lines[index]!;
    if (text.startsWith("@@ ")) {
      inHunk = true;
      index++;
      continue;
    }
    if (!inHunk || text.startsWith("\\")) {
      index++;
      continue;
    }
    if (text.startsWith(" ")) {
      if (logicalRow++ === row) return diffLineTarget(diff, index);
      index++;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (index < lines.length) {
      const changed = lines[index]!;
      if (changed.startsWith("-")) removed.push(index++);
      else if (changed.startsWith("+")) added.push(index++);
      else break;
    }
    const count = Math.max(removed.length, added.length);
    if (count === 0) {
      index++;
      continue;
    }
    if (row >= logicalRow && row < logicalRow + count) {
      const raw = (side === "old" ? removed : added)[row - logicalRow];
      return raw === undefined ? undefined : diffLineTarget(diff, raw);
    }
    logicalRow += count;
  }
  return undefined;
}

/** Changed raw patch rows crossed by a drag range, inclusive. */
export function changedDiffRowsInRange(
  diff: string,
  from: number,
  to: number,
): number[] {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.max(from, to);
  const rows: number[] = [];
  for (let row = start; row <= end; row++) {
    const target = diffLineTarget(diff, row);
    if (target && target.kind !== "context") rows.push(row);
  }
  return rows;
}
