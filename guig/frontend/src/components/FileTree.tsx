import { useMemo, useState } from "react";
import type { ChangedFile, FileState } from "../../../shared/types.js";

export interface FileTreeProps {
  files: ChangedFile[];
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
}

interface DirNode {
  kind: "directory";
  name: string;
  path: string;
  children: TreeNode[];
  status?: FileState;
}

interface FileNode {
  kind: "file";
  name: string;
  file: ChangedFile;
}

type TreeNode = DirNode | FileNode;

const BADGES: Record<FileState, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  conflicted: "!",
};

function iconForFile(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "◈";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "◇";
    case "json":
      return "⬡";
    case "css":
    case "scss":
    case "less":
      return "▤";
    case "html":
    case "htm":
      return "▦";
    case "md":
    case "markdown":
      return "▨";
    case "py":
      return "△";
    case "rs":
      return "▽";
    case "go":
      return "○";
    case "yaml":
    case "yml":
    case "toml":
      return "≣";
    case "lock":
      return "⬢";
    default:
      return "▢";
  }
}

function buildTree(files: ChangedFile[]): DirNode {
  const root: DirNode = { kind: "directory", name: "", path: "", children: [] };
  const dirs = new Map<string, DirNode>([["", root]]);
  for (const file of files) {
    const parts = file.path.split("/");
    const leaf = parts.pop() ?? file.path;
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
    parent.children.push({ kind: "file", name: leaf, file });
  }
  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes)
      if (node.kind === "directory") sortNodes(node.children);
  };
  sortNodes(root.children);
  return root;
}

function stageDot(file: ChangedFile): { glyph: string; title: string } {
  if (file.staged && file.unstaged)
    return { glyph: "◐", title: "staged and unstaged" };
  if (file.staged) return { glyph: "●", title: "staged" };
  return { glyph: "○", title: "unstaged" };
}

/** Collapsible folder tree over repository-relative file paths. */
export function FileTree({
  files,
  selectedPath,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: FileTreeProps): React.JSX.Element {
  const root = useMemo(() => buildTree(files), [files]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        root.children
          .filter((c) => c.kind === "directory")
          .map((c) => (c as DirNode).path),
      ),
  );

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (files.length === 0)
    return <div className="guig-filetree-empty">No files</div>;

  const renderNodes = (nodes: TreeNode[], depth: number): React.JSX.Element[] =>
    nodes.flatMap((node): React.JSX.Element[] => {
      if (node.kind === "directory") {
        const open = expanded.has(node.path) || node.path === "";
        const rows: React.JSX.Element[] = [
          <div
            key={`dir:${node.path}`}
            className="guig-tree-dir"
            style={{ paddingLeft: depth * 14 }}
          >
            <button
              type="button"
              className="guig-tree-toggle"
              aria-label={
                open ? `Collapse ${node.path}` : `Expand ${node.path}`
              }
              aria-expanded={open}
              onClick={() => toggle(node.path)}
            >
              {open ? "▾" : "▸"}
            </button>
            <span
              className="guig-tree-dirname"
              onClick={() => toggle(node.path)}
            >
              {node.name}/
            </span>
          </div>,
        ];
        if (open) rows.push(...renderNodes(node.children, depth + 1));
        return rows;
      }
      const { file } = node;
      const dot = stageDot(file);
      const selected = file.path === selectedPath;
      return [
        <div
          key={`file:${file.path}`}
          className={`guig-tree-file${selected ? " selected" : ""}`}
          style={{ paddingLeft: depth * 14 + 16 }}
          onClick={() => onSelect?.(file.path)}
          onContextMenu={(event) => {
            event.preventDefault();
            window.dispatchEvent(
              new CustomEvent("guig:file-menu", {
                detail: {
                  path: file.path,
                  staged: file.staged,
                  x: event.clientX,
                  y: event.clientY,
                },
              }),
            );
          }}
          role="option"
          aria-selected={selected}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSelect?.(file.path);
          }}
        >
          <span className="guig-tree-icon" aria-hidden="true" title={file.path}>
            {iconForFile(node.name)}
          </span>
          <span className="guig-tree-filename" title={file.path}>
            {node.name}
          </span>
          <span
            className={`guig-badge guig-badge-${file.state}`}
            title={file.state}
          >
            {BADGES[file.state]}
          </span>
          <span
            className={`guig-dot${file.staged ? " staged" : ""}`}
            title={dot.title}
            aria-label={dot.title}
          >
            {dot.glyph}
          </span>
          <span className="guig-tree-actions">
            {file.unstaged && onStage && (
              <button
                type="button"
                title="Stage (s)"
                aria-label={`Stage ${file.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onStage(file.path);
                }}
              >
                +
              </button>
            )}
            {file.staged && onUnstage && (
              <button
                type="button"
                title="Unstage (u)"
                aria-label={`Unstage ${file.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onUnstage(file.path);
                }}
              >
                −
              </button>
            )}
            {file.unstaged && onDiscard && (
              <button
                type="button"
                title="Discard changes"
                aria-label={`Discard ${file.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard(file.path);
                }}
              >
                ×
              </button>
            )}
          </span>
        </div>,
      ];
    });

  return (
    <div className="guig-filetree" role="listbox" aria-label="Changed files">
      {renderNodes(root.children, 0)}
    </div>
  );
}
