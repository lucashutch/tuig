import { StyledText, bg, fg } from "@opentui/core";
import type { RepositorySnapshot } from "../git/types.js";
import { displayBranchName } from "./history.js";
import { oneDarkTheme } from "./theme.js";
import { clipColumns } from "./runtime-presentation-text.js";

export type HeaderPresentationInput = {
  snapshot?: RepositorySnapshot;
  repositoryRoot: string;
  width: number;
};

/** Relative age used by the header's sync indicator. */
export function formatAge(
  syncedAt: number | undefined,
  now = Date.now(),
): string {
  if (syncedAt === undefined) return "not synced";
  const seconds = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (seconds < 10) return "synced just now";
  if (seconds < 60) return `synced ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `synced ${minutes}m ago`;
  return `synced ${Math.floor(minutes / 60)}h ago`;
}

/**
 * Repository header shown above every pane, so branch and working state survive
 * collapsing the repository pane.
 */
export function renderHeader({
  snapshot,
  repositoryRoot,
  width,
}: HeaderPresentationInput): StyledText {
  const name = repositoryRoot.split("/").filter(Boolean).at(-1) ?? "repository";
  const raised = oneDarkTheme.panelRaised;
  const segments: Array<{ text: string; color: string }> = [
    { text: ` ◉ ${name}`, color: oneDarkTheme.accent },
  ];
  if (!snapshot) {
    segments.push({ text: "  loading…", color: oneDarkTheme.muted });
  } else {
    segments.push({
      text: `  ${displayBranchName(snapshot.branch ?? "detached HEAD")}`,
      color: oneDarkTheme.warning,
    });
    if (snapshot.ahead > 0)
      segments.push({
        text: `  ↑${snapshot.ahead}`,
        color: oneDarkTheme.added,
      });
    if (snapshot.behind > 0)
      segments.push({
        text: `  ↓${snapshot.behind}`,
        color: oneDarkTheme.deleted,
      });
    if (snapshot.ahead === 0 && snapshot.behind === 0)
      segments.push({
        text: snapshot.upstream ? "  up to date" : "  no upstream",
        color: oneDarkTheme.muted,
      });
    segments.push(
      snapshot.files.length > 0
        ? {
            text: `  ${snapshot.files.length} changed`,
            color: oneDarkTheme.warning,
          }
        : { text: "  clean", color: oneDarkTheme.muted },
    );
  }
  let room = Math.max(0, width);
  for (const segment of segments) {
    segment.text = clipColumns(segment.text, room);
    room -= Bun.stringWidth(segment.text);
  }
  const used = segments.reduce(
    (total, segment) => total + Bun.stringWidth(segment.text),
    0,
  );
  const gap = Math.max(0, width - used);
  segments.push({
    text: " ".repeat(gap),
    color: oneDarkTheme.muted,
  });
  return new StyledText(
    segments.map((segment) => bg(raised)(fg(segment.color)(segment.text))),
  );
}

export type ToolbarAction =
  | "fetch"
  | "pull"
  | "push"
  | "stash"
  | "pop"
  | "refresh";

export type ToolbarButton = {
  id: ToolbarAction;
  label: string;
  glyph: string;
  enabled: boolean;
};

export type ToolbarHit = { id: ToolbarAction; start: number; end: number };

export type ToolbarPresentation = {
  content: StyledText;
  hits: ToolbarHit[];
};

/** The toolbar's actions, with the ones the repository cannot do greyed out. */
export function toolbarButtons(
  snapshot: RepositorySnapshot | undefined,
): ToolbarButton[] {
  const tracked = Boolean(snapshot?.upstream);
  return [
    { id: "fetch", label: "Fetch", glyph: "󰇚", enabled: Boolean(snapshot) },
    { id: "pull", label: "Pull", glyph: "↓", enabled: tracked },
    { id: "push", label: "Push", glyph: "↑", enabled: tracked },
    {
      id: "stash",
      label: "Stash",
      glyph: "󰆓",
      enabled: (snapshot?.files.length ?? 0) > 0,
    },
    {
      id: "pop",
      label: "Pop",
      glyph: "󰄼",
      enabled: (snapshot?.stashes.length ?? 0) > 0,
    },
    { id: "refresh", label: "Refresh", glyph: "󰑓", enabled: Boolean(snapshot) },
  ];
}

/**
 * Two centred rows of toolbar buttons: labels above their glyphs, with the
 * column range each button answers to.
 */
export function renderToolbar(
  buttons: ToolbarButton[],
  width: number,
  interaction: {
    hovered?: ToolbarAction;
    pressed?: ToolbarAction;
    busy?: string;
  } = {},
): ToolbarPresentation {
  const gap = 2;
  const cells = buttons.map((button) => ({
    button,
    width:
      Math.max(Bun.stringWidth(button.label), Bun.stringWidth(button.glyph)) +
      gap * 2,
  }));
  const strip = cells.reduce((total, cell) => total + cell.width, 0);
  const lead = Math.max(0, Math.floor((width - strip) / 2));
  const raised = oneDarkTheme.panelRaised;
  const labels = [bg(raised)(" ".repeat(lead))];
  const glyphs = [bg(raised)(" ".repeat(lead))];
  const hits: ToolbarHit[] = [];
  let column = lead;
  for (const { button, width: cellWidth } of cells) {
    const centre = (value: string) => {
      const padding = cellWidth - Bun.stringWidth(value);
      const before = Math.floor(padding / 2);
      return " ".repeat(before) + value + " ".repeat(padding - before);
    };
    const labelColor = button.enabled ? oneDarkTheme.text : oneDarkTheme.border;
    const glyphColor = button.enabled
      ? oneDarkTheme.accent
      : oneDarkTheme.border;
    const pressed = button.enabled && interaction.pressed === button.id;
    const background = pressed
      ? oneDarkTheme.dividerActive
      : button.enabled && interaction.hovered === button.id
        ? oneDarkTheme.selected
        : raised;
    labels.push(bg(background)(fg(labelColor)(centre(button.label))));
    glyphs.push(bg(background)(fg(glyphColor)(centre(button.glyph))));
    if (button.enabled)
      hits.push({ id: button.id, start: column, end: column + cellWidth });
    column += cellWidth;
  }
  const trail = Math.max(0, width - column);
  // Keep progress clear of the buttons and four columns from the right edge.
  const status = clipColumns(interaction.busy ?? "", Math.max(0, trail - 5));
  const inset = status ? 4 : 0;
  labels.push(bg(raised)(" ".repeat(trail - Bun.stringWidth(status) - inset)));
  labels.push(bg(raised)(fg(oneDarkTheme.accent)(status + " ".repeat(inset))));
  glyphs.push(bg(raised)(" ".repeat(trail)), fg(oneDarkTheme.border)(""));
  return {
    content: new StyledText([...labels, bg(raised)("\n"), ...glyphs]),
    hits,
  };
}

/** The toolbar button, if any, under a click. */
export function toolbarHit(
  hits: ToolbarHit[],
  x: number,
): ToolbarAction | undefined {
  return hits.find((hit) => x >= hit.start && x < hit.end)?.id;
}

export type HintContext = {
  focus: "history" | "changes";
  view: "history" | "commit" | "working";
  composing: boolean;
};

/**
 * Keybinding hints for the current focus, so the bottom row keeps teaching
 * the keys that actually apply right now.
 */
export function formatHints({ focus, view, composing }: HintContext): string {
  if (composing) return "COMPOSER  ↵ commit  ⇥ summary/description  esc cancel";
  const shared = "⇥ pane  [ ] collapse  r refresh  q quit";
  if (view !== "history")
    return `${focus === "changes" ? "CHANGES" : "DIFF"}  esc back to graph  ←/→ file  s stage  u unstage  ${shared}`;
  if (focus === "changes")
    return `CHANGES  ←/→ file  s stage  u unstage  h hunk  t section  c commit  ${shared}`;
  return `HISTORY  j/k move  ←/→ pan graph  ↵ open commit  / filter branches  esc cancel/clear  dbl-click branch checkout  right-click actions  ${shared}`;
}
