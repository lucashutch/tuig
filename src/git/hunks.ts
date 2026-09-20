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

/** Build an applicable patch containing only the selected changed rows. */
export function selectPatchLines(
  patch: string,
  selectedRows: ReadonlySet<number>,
  preserve: "old" | "new" = "old",
): string {
  if (!selectedRows.size) return "";
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0) return "";
  const preamble = lines.slice(0, firstHunk);
  const output: string[] = [];
  let index = firstHunk;
  while (index < lines.length) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(
      lines[index] ?? "",
    );
    if (!match) {
      index++;
      continue;
    }
    let oldStart = Number(match[1]);
    const newStart = Number(match[3]);
    const suffix = match[5] ?? "";
    index++;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let changed = false;
    let previousRowKept = false;
    while (index < lines.length && !lines[index]!.startsWith("@@ ")) {
      const line = lines[index]!;
      if (line.startsWith("diff --git ")) break;
      if (!line && index === lines.length - 1) {
        index++;
        break;
      }
      if (line.startsWith("\\ No newline at end of file")) {
        if (previousRowKept) body.push(line);
      } else if (line.startsWith("+")) {
        if (selectedRows.has(index)) {
          body.push(line);
          newCount++;
          changed = true;
          previousRowKept = true;
        } else if (preserve === "new") {
          body.push(` ${line.slice(1)}`);
          oldCount++;
          newCount++;
          previousRowKept = true;
        } else {
          previousRowKept = false;
        }
      } else if (line.startsWith("-")) {
        if (selectedRows.has(index)) {
          body.push(line);
          oldCount++;
          changed = true;
          previousRowKept = true;
        } else if (preserve === "old") {
          body.push(` ${line.slice(1)}`);
          oldCount++;
          newCount++;
          previousRowKept = true;
        } else {
          if (!body.length) oldStart++;
          previousRowKept = false;
        }
      } else {
        body.push(line);
        oldCount++;
        newCount++;
        previousRowKept = true;
      }
      index++;
    }
    if (changed) {
      output.push(
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix}`,
        ...body,
      );
    }
  }
  if (!output.length) return "";
  return `${[...preamble, ...output].join("\n")}\n`;
}
