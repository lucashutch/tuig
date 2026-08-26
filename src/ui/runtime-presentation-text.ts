import type { FileTreeNode } from "./file-tree.js";
import { oneDarkTheme } from "./theme.js";

/** Status colour for a tree node; the material icon carries the git state. */
export function fileColor(node: FileTreeNode): string | undefined {
  const state = node.kind === "directory" ? node.status : node.state;
  if (!state)
    return node.kind === "directory" ? oneDarkTheme.folder : undefined;
  if (state === "deleted" || state === "conflicted")
    return oneDarkTheme.deleted;
  if (state === "added" || state === "untracked") return oneDarkTheme.added;
  if (state === "renamed" || state === "copied") return oneDarkTheme.accent;
  return oneDarkTheme.warning;
}

export function wrappedLineCount(value: string, width: number): number {
  return Math.max(
    1,
    value
      .split("\n")
      .reduce(
        (lines, line) => lines + Math.max(1, Math.ceil(line.length / width)),
        0,
      ),
  );
}

export function fitColumns(
  value: string,
  width: number,
  ellipsis = false,
): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(value) <= width)
    return value + " ".repeat(width - Bun.stringWidth(value));
  const suffix = ellipsis && width > 1 ? "…" : "";
  const target = width - Bun.stringWidth(suffix);
  let result = "";
  for (const character of value) {
    if (Bun.stringWidth(result + character) > target) break;
    result += character;
  }
  result += suffix;
  return result + " ".repeat(Math.max(0, width - Bun.stringWidth(result)));
}

/** Truncate to a column budget without padding the remainder. */
export function clipColumns(value: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(value) <= width) return value;
  const target = Math.max(0, width - 1);
  let result = "";
  for (const character of value) {
    if (Bun.stringWidth(result + character) > target) break;
    result += character;
  }
  return `${result}…`;
}

export function fileViewportSize(
  view: "history" | "commit" | "working",
  terminalHeight: number,
  commitFilesTop: number,
): number {
  return view === "commit"
    ? Math.max(1, terminalHeight - commitFilesTop - 2)
    : Math.max(1, Math.min(7, terminalHeight - 3));
}
