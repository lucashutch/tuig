import type {
  BranchRef,
  ChangedFile,
  RepositorySnapshot,
  Stash,
  Worktree,
} from "../git/types.js";
import { displayBranchName, shortSha } from "./history.js";

export type GraphMenuAction =
  | "checkout-branch"
  | "checkout-commit"
  | "reset-soft"
  | "reset-mixed"
  | "reset-hard"
  | "rebase-onto"
  | "create-branch"
  | "create-tag"
  | "cherry-pick"
  | "delete-branch"
  | "apply-stash"
  | "pop-stash"
  | "drop-stash"
  /** Kept as an alias for callers built against the pre-Phase 2 menu. */
  | "delete-stash"
  | "copy-sha"
  | "copy-branch"
  | "stage-file"
  | "unstage-file"
  | "discard-file"
  | "copy-path"
  | "remove-worktree"
  | "lock-worktree"
  | "unlock-worktree";

export interface GraphMenuItem {
  label: string;
  action?: GraphMenuAction;
  submenu?: GraphMenuItem[];
  destructive?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

/** What a graph row click landed on: always a commit, sometimes a branch. */
export interface GraphMenuTarget {
  sha: string;
  branch?: BranchRef;
  stash?: Stash;
  worktree?: Worktree;
  file?: ChangedFile;
  /** Which changes list the file came from; drives stage vs unstage. */
  fileStaged?: boolean;
}

/** A menu pane placed in terminal coordinates. */
export interface MenuPlacement {
  items: readonly GraphMenuItem[];
  left: number;
  top: number;
  width: number;
}

const SUBMENU_MARKER = " ▸";

/**
 * Build the menu for a right-clicked graph row.
 *
 * Branch entries come first when a branch label was hit, because that is what
 * the click was aimed at; the commit entries below apply either way.
 */
export function buildGraphMenu(
  target: GraphMenuTarget,
  snapshot: Pick<RepositorySnapshot, "branch" | "branches" | "root">,
): { title: string; items: GraphMenuItem[] } {
  const current = snapshot.branch ?? "HEAD";
  const items: GraphMenuItem[] = [];
  const branch = target.branch;
  if (target.worktree) return worktreeMenu(target.worktree, snapshot.root);
  if (target.file) return fileMenu(target.file, target.fileStaged === true);
  if (target.stash) {
    return {
      title: `stash · ${shortSha(target.sha)}`,
      items: [
        { label: `Apply ${target.stash.ref}`, action: "apply-stash" },
        {
          label: `Pop ${target.stash.ref}`,
          action: "pop-stash",
          destructive: true,
        },
        {
          label: `Drop ${target.stash.ref}`,
          action: "drop-stash",
          destructive: true,
        },
      ],
    };
  }
  if (branch) {
    const name = branch.name;
    items.push(
      {
        label: branch.current
          ? `Already on ${displayBranchName(name)}`
          : `Checkout ${displayBranchName(name)}`,
        action: "checkout-branch",
        disabled: branch.current,
      },
      {
        label: `Rebase ${current} onto ${displayBranchName(name)}`,
        action: "rebase-onto",
        disabled: branch.current,
      },
      resetSubmenu(current, displayBranchName(name)),
      { label: "Copy branch name", action: "copy-branch" },
      { label: "Create branch here", action: "create-branch" },
      {
        label: `Delete ${displayBranchName(name)}`,
        action: "delete-branch",
        destructive: true,
        disabled: branch.current,
      },
      { label: "", separator: true },
    );
  }
  items.push(
    { label: "Checkout this commit (detached)", action: "checkout-commit" },
    { label: `Rebase ${current} onto this commit`, action: "rebase-onto" },
    resetSubmenu(current, "this commit"),
    { label: "Create branch here", action: "create-branch" },
    { label: "Cherry-pick this commit", action: "cherry-pick" },
    { label: "Create tag here", action: "create-tag" },
    { label: "Copy commit SHA", action: "copy-sha" },
  );
  return {
    title: branch
      ? `${displayBranchName(branch.name)} · ${shortSha(target.sha)}`
      : shortSha(target.sha),
    items,
  };
}

/** Menu for a right-clicked worktree row. The main checkout cannot be removed. */
function worktreeMenu(
  worktree: Worktree,
  root: string,
): { title: string; items: GraphMenuItem[] } {
  const name =
    worktree.path.replace(/\/+$/, "").split("/").at(-1) ?? worktree.path;
  const main = worktree.path.replace(/\/+$/, "") === root.replace(/\/+$/, "");
  const items: GraphMenuItem[] = [];
  if (!main)
    items.push(
      worktree.locked === undefined
        ? { label: `Lock ${name}`, action: "lock-worktree" }
        : {
            label: `Unlock ${name}`,
            action: "unlock-worktree",
          },
      {
        label: `Remove ${name}`,
        action: "remove-worktree",
        destructive: true,
      },
    );
  items.push({ label: "Copy path", action: "copy-path" });
  return { title: name, items };
}

/** Menu for a right-clicked row in the staged or unstaged changes list. */
function fileMenu(
  file: ChangedFile,
  staged: boolean,
): { title: string; items: GraphMenuItem[] } {
  const name = file.path.split("/").at(-1) ?? file.path;
  const items: GraphMenuItem[] = staged
    ? [{ label: `Unstage ${name}`, action: "unstage-file" }]
    : [
        { label: `Stage ${name}`, action: "stage-file" },
        {
          label: `Discard changes in ${name}`,
          action: "discard-file",
          destructive: true,
        },
      ];
  items.push({ label: "Copy path", action: "copy-path" });
  return { title: file.path, items };
}

function resetSubmenu(current: string, destination: string): GraphMenuItem {
  return {
    label: `Reset ${current} to ${destination}`,
    submenu: [
      { label: "Soft · keep index and working tree", action: "reset-soft" },
      { label: "Mixed · keep working tree", action: "reset-mixed" },
      {
        label: "Hard · discard all local changes",
        action: "reset-hard",
        destructive: true,
      },
    ],
  };
}

export function menuWidth(items: readonly GraphMenuItem[]): number {
  return (
    Math.max(
      16,
      ...items.map(
        (item) =>
          Bun.stringWidth(item.label) +
          (item.submenu ? SUBMENU_MARKER.length : 0),
      ),
      // One space of padding on each side, inside the two border columns.
    ) + 4
  );
}

/** Fit a menu of `rows` rows inside the terminal, flipping it when needed. */
export function placeMenu(
  x: number,
  y: number,
  width: number,
  rows: number,
  terminalWidth: number,
  terminalHeight: number,
): { left: number; top: number } {
  const height = rows + 2;
  const left =
    x + width > terminalWidth ? Math.max(0, terminalWidth - width) : x;
  const top =
    y + height > terminalHeight ? Math.max(0, terminalHeight - height) : y;
  return { left, top };
}

/** Row index under a pointer, or undefined when it is outside the list. */
export function menuRowAt(
  menu: MenuPlacement,
  x: number,
  y: number,
): number | undefined {
  if (x < menu.left || x >= menu.left + menu.width) return undefined;
  const row = y - menu.top - 1;
  if (row < 0 || row >= menu.items.length) return undefined;
  return menu.items[row]?.separator ? undefined : row;
}

export function renderMenuLine(item: GraphMenuItem, width: number): string {
  if (item.separator) return "─".repeat(width);
  const marker = item.submenu ? SUBMENU_MARKER : "";
  const room = Math.max(1, width - 2 - marker.length);
  const label = item.label.slice(0, room).padEnd(room);
  return ` ${label}${marker} `;
}

export interface ConfirmRequest {
  title: string;
  lines: string[];
  confirmLabel: string;
  destructive?: boolean;
}
