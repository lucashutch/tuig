import type { JSX } from "react";
import type { RepositorySnapshot } from "../../../shared/types.js";

export type ToolbarActionId =
  | "fetch"
  | "pull"
  | "push"
  | "stash"
  | "pop"
  | "refresh";

interface ToolbarProps {
  snapshot: RepositorySnapshot | undefined;
  busy: boolean;
  onAction: (action: ToolbarActionId) => void;
}

export function toolbarEnabled(
  snapshot: RepositorySnapshot | undefined,
  action: ToolbarActionId,
): boolean {
  switch (action) {
    case "fetch":
      return Boolean(snapshot);
    case "pull":
    case "push":
      return Boolean(snapshot?.upstream);
    case "stash":
      return (snapshot?.files.length ?? 0) > 0;
    case "pop":
      return (snapshot?.stashes.length ?? 0) > 0;
    case "refresh":
      return Boolean(snapshot);
  }
}

const BUTTONS: Array<{ id: ToolbarActionId; label: string; glyph: string }> = [
  { id: "fetch", label: "Fetch", glyph: "\u{1F503}" },
  { id: "pull", label: "Pull", glyph: "\u2193" },
  { id: "push", label: "Push", glyph: "\u2191" },
  { id: "stash", label: "Stash", glyph: "\u229E" },
  { id: "pop", label: "Pop", glyph: "\u23CF" },
  { id: "refresh", label: "Refresh", glyph: "\u27F3" },
];

export function Toolbar({
  snapshot,
  busy,
  onAction,
}: ToolbarProps): JSX.Element {
  return (
    <div
      className="guig-toolbar"
      role="toolbar"
      aria-label="Repository actions"
    >
      {BUTTONS.map((button) => {
        const enabled = !busy && toolbarEnabled(snapshot, button.id);
        return (
          <button
            key={button.id}
            type="button"
            disabled={!enabled}
            onClick={() => onAction(button.id)}
            title={button.label}
          >
            <span>{button.label}</span>
            <span className="glyph" aria-hidden="true">
              {button.glyph}
            </span>
          </button>
        );
      })}
    </div>
  );
}
