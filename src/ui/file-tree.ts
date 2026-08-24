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
  if (label.length <= width) return label;
  if (width === 1) return "…";
  if (width < 5) return `${label.slice(0, width - 1)}…`;
  const tail = Math.max(2, Math.floor((width - 1) * 0.4));
  const head = width - tail - 1;
  return `${label.slice(0, head)}…${label.slice(-tail)}`;
}
