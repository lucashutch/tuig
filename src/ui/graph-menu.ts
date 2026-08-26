import type { BranchRef, RepositorySnapshot, Stash } from "../git/types.js";
import { displayBranchName, shortSha } from "./history.js";

export type GraphMenuAction =
  | "checkout-branch"
  | "checkout-commit"
  | "reset-soft"
  | "reset-mixed"
  | "reset-hard"
  | "rebase-onto"
  | "delete-branch"
  | "delete-stash"
  | "copy-sha"
  | "copy-branch";

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
  snapshot: Pick<RepositorySnapshot, "branch" | "branches">,
): { title: string; items: GraphMenuItem[] } {
  const current = snapshot.branch ?? "HEAD";
  const items: GraphMenuItem[] = [];
  const branch = target.branch;
  if (target.stash) {
    return {
      title: `stash · ${shortSha(target.sha)}`,
      items: [
        {
          label: `Delete ${target.stash.ref}`,
          action: "delete-stash",
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
    { label: "Copy commit SHA", action: "copy-sha" },
  );
  return {
    title: branch
      ? `${displayBranchName(branch.name)} · ${shortSha(target.sha)}`
      : shortSha(target.sha),
    items,
  };
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
