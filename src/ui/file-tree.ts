import type { ChangedFile, FileState } from "../git/types.js";

/** The two deliberately small node types used by the changed-files view. */
export interface FileTreeFile extends ChangedFile {
  kind: "file";
  name: string;
  depth?: never;
}

export interface FileTreeDirectory {
  kind: "directory";
  name: string;
  /** Repository-relative path (the empty string is the synthetic root). */
  path: string;
  children: FileTreeNode[];
  status?: FileState;
}

export type FileTreeNode = FileTreeFile | FileTreeDirectory;
export interface VisibleFileTreeNode {
  node: FileTreeNode;
  depth: number;
}

/** Return every changed file below a row, independent of expansion state. */
export function descendantFiles(node: FileTreeNode): FileTreeFile[] {
  if (node.kind === "file") return [node];
  return node.children.flatMap(descendantFiles);
}

export type FileRowAction = "stage" | "discard" | "unstage";
export interface FileRowActionHit {
  action: FileRowAction;
  label: string;
  start: number;
  end: number;
}

/** Right-aligned action geometry shared by painting and mouse hit testing. */
export function fileRowActionHits(
  section: "staged" | "unstaged",
  width: number,
  prefixWidth = 6,
): FileRowActionHit[] {
  const actions: Array<[FileRowAction, string]> =
    section === "staged"
      ? [["unstage", " Unstage "]]
      : [
          ["stage", " Stage "],
          ["discard", " Discard "],
        ];
  const total = actions.reduce((sum, [, label]) => sum + label.length, 0);
  // Keep the full tree prefix and at least one column of the row name visible.
  // The same condition controls painting and hit testing.
  if (width < prefixWidth + 1 + total) return [];
  let start = width - total;
  return actions.map(([action, label]) => {
    const hit = { action, label, start, end: start + label.length };
    start = hit.end;
    return hit;
  });
}

// This order is intentional: a directory containing a conflict remains visibly
// important even when it also contains ordinary modifications.
const stateRank: Record<FileState, number> = {
  conflicted: 8,
  deleted: 7,
  renamed: 6,
  copied: 5,
  modified: 4,
  added: 3,
  untracked: 2,
};

function directoryStatus(children: FileTreeNode[]): FileState | undefined {
  let result: FileState | undefined;
  for (const child of children) {
    const state: FileState | undefined =
      child.kind === "file" ? child.state : child.status;
    if (state && (!result || stateRank[state] > stateRank[result]))
      result = state;
  }
  return result;
}

function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes)
    if (node.kind === "directory") {
      sortNodes(node.children);
      node.status = directoryStatus(node.children);
    }
}

/** Build a synthetic directory tree. Paths are never shortened or discarded. */
export function buildFileTree(files: ChangedFile[]): FileTreeDirectory {
  const root: FileTreeDirectory = {
    kind: "directory",
    name: "",
    path: "",
    children: [],
  };
  const dirs = new Map<string, FileTreeDirectory>([["", root]]);
  for (const file of files) {
    const parts = file.path.split("/");
    const leaf = parts.pop() ?? "";
    let parent = root;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let dir = dirs.get(path);
      if (!dir) {
        dir = { kind: "directory", name: part, path, children: [] };
        dirs.set(path, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    // A ChangedFile path is the identity; duplicate inputs are retained.
    parent.children.push({ ...file, kind: "file", name: leaf });
  }
  sortNodes(root.children);
  root.status = directoryStatus(root.children);
  return root;
}

const treeCache = new WeakMap<readonly ChangedFile[], FileTreeDirectory>();

/**
 * Cache by immutable snapshot array identity. Runtime snapshots replace file
 * arrays instead of mutating them, and WeakMap entries cannot retain history.
 */
export function cachedFileTree(
  files: readonly ChangedFile[],
): FileTreeDirectory {
  const cached = treeCache.get(files);
  if (cached) return cached;
  const tree = buildFileTree([...files]);
  treeCache.set(files, tree);
  return tree;
}

const flattenedCache = new WeakMap<
  FileTreeDirectory,
  { expansion: ReadonlySet<string>; rows: VisibleFileTreeNode[] }
>();

/** Reuse flattening while detecting Sets mutated in place. */
export function cachedFlattenVisible(
  tree: FileTreeDirectory,
  expanded: ReadonlySet<string>,
): VisibleFileTreeNode[] {
  const cached = flattenedCache.get(tree);
  if (
    cached?.expansion.size === expanded.size &&
    [...expanded].every((path) => cached.expansion.has(path))
  )
    return cached.rows;
  const rows = flattenVisible(tree, expanded);
  flattenedCache.set(tree, { expansion: new Set(expanded), rows });
  return rows;
}

/** Return rows in display order. The synthetic root itself is not a row. */
export function flattenVisible(
  tree: FileTreeDirectory | FileTreeNode[],
  expanded: ReadonlySet<string> = new Set(),
): VisibleFileTreeNode[] {
  const rows: VisibleFileTreeNode[] = [];
  const visit = (nodes: FileTreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === "directory" && expanded.has(node.path))
        visit(node.children, depth + 1);
    }
  };
  visit(Array.isArray(tree) ? tree : tree.children, 0);
  return rows;
}

export function toggleExpansion(
  expanded: ReadonlySet<string>,
  path: string,
): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** Expand newly discovered directories once, while preserving user collapses. */
export function expandNewDirectories(
  tree: FileTreeDirectory,
  expanded: Set<string>,
  seen: Set<string>,
): void {
  const visit = (nodes: readonly FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind !== "directory") continue;
      if (!seen.has(node.path)) {
        seen.add(node.path);
        expanded.add(node.path);
      }
      visit(node.children);
    }
  };
  visit(tree.children);
}

/** Locate the visible row for a repository-relative file path. */
export function selectedFileRow(
  rows: readonly VisibleFileTreeNode[],
  path: string,
): number {
  return rows.findIndex(
    (row) => row.node.kind === "file" && row.node.path === path,
  );
}

/** Keep each node on one terminal row while retaining both ends of long names. */
export function fitTreeLabel(label: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(label) <= width) return label;
  if (width === 1) return "…";
  if (width < 5) return `${takeColumns(label, width - 1)}…`;
  const tail = Math.max(2, Math.floor((width - 1) * 0.4));
  const head = width - tail - 1;
  return `${takeColumns(label, head)}…${takeColumns(label, tail, true)}`;
}

function takeColumns(text: string, width: number, fromEnd = false): string {
  const characters = Array.from(text);
  if (fromEnd) characters.reverse();
  const result: string[] = [];
  let used = 0;
  for (const character of characters) {
    const columns = Bun.stringWidth(character);
    if (used + columns > width) break;
    result.push(character);
    used += columns;
  }
  if (fromEnd) result.reverse();
  return result.join("");
}
