import { clipColumns } from "./runtime-presentation-text.js";

/** A repository that can be shown in the tab strip. */
export interface RepositoryTab {
  /** Stable identity used by click handlers. */
  id: string;
  /** Repository root, when the caller has one available. */
  path?: string;
  /** Alternative root spelling useful to callers that model Git repositories. */
  root?: string;
  /** Text shown in the strip. The root name is used when this is omitted. */
  label?: string;
  /** Alternative display spelling used by some repository lists. */
  name?: string;
}

export type RepositoryTabStyle = "active" | "inactive";

/** Coordinates and presentation data for one visible repository tab. */
export interface RepositoryTabLayout {
  id: string;
  path?: string;
  root?: string;
  /** The label after fitting it to the tab's available columns. */
  label: string;
  /** The unmodified label, useful for tooltips or accessibility text. */
  fullLabel: string;
  active: boolean;
  style: RepositoryTabStyle;
  /** Half-open range occupied by the whole tab. */
  start: number;
  end: number;
  /** Half-open range occupied by the close affordance. */
  closeStart: number;
  closeEnd: number;
}

export interface RepositoryTabOpenHit {
  action: "open";
  start: number;
  end: number;
}

export interface RepositoryTabsLayout {
  /** The non-negative terminal width used for this layout. */
  width: number;
  /** Tabs that fit in the strip, in their original order. */
  tabs: RepositoryTabLayout[];
  /** The range for the + action. It is kept visible when tabs overflow. */
  open: RepositoryTabOpenHit;
  /** Number of tabs omitted at either edge of the strip. */
  hiddenBefore: number;
  hiddenAfter: number;
}

export type RepositoryTabHit =
  | { action: "select"; tabId: string }
  | { action: "close"; tabId: string }
  | { action: "open" };

const CLOSE_WIDTH = 1;
const TAB_OVERHEAD = 3;
const MIN_TAB_WIDTH = TAB_OVERHEAD + 1;
const OPEN_WIDTH = 3;
const TAB_GAP = 1;

function terminalWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function labelFor(tab: RepositoryTab): string {
  if (tab.label !== undefined && tab.label.length > 0) return tab.label;
  if (tab.name !== undefined && tab.name.length > 0) return tab.name;
  const path = tab.path ?? tab.root;
  if (path) {
    const trimmed = path.replace(/[\\/]+$/, "");
    return trimmed.split(/[\\/]/).at(-1) || path;
  }
  return tab.id;
}

function columnWidth(value: string): number {
  return Bun.stringWidth(value);
}

function naturalTabWidth(label: string): number {
  return Math.max(MIN_TAB_WIDTH, columnWidth(label) + TAB_OVERHEAD);
}

/** Select a contiguous window while keeping the active tab on screen. */
function visibleWindow(
  tabs: readonly RepositoryTab[],
  budget: number,
  activeId: string | undefined,
): { start: number; end: number } {
  if (tabs.length === 0 || budget < MIN_TAB_WIDTH) return { start: 0, end: 0 };

  // The minimum width lets every visible tab retain a label cell and a close
  // hit. This gives a useful bound even when every repository name is long.
  const count = Math.min(
    tabs.length,
    Math.max(1, Math.floor((budget + TAB_GAP) / (MIN_TAB_WIDTH + TAB_GAP))),
  );
  if (count === tabs.length) return { start: 0, end: tabs.length };

  const active = activeId ? tabs.findIndex((tab) => tab.id === activeId) : -1;
  if (active < 0) return { start: 0, end: count };

  // Centre the active tab as far as the edges allow. Keeping the selected
  // count fixed is important because the width budget was calculated from
  // that count, not from the potentially much longer natural labels.
  const start = Math.max(
    0,
    Math.min(active - Math.floor((count - 1) / 2), tabs.length - count),
  );
  return { start, end: start + count };
}

function fitTabWidths(natural: readonly number[], budget: number): number[] {
  const widths = natural.map((width) => Math.max(MIN_TAB_WIDTH, width));
  let remaining = widths.reduce((total, width) => total + width, 0) - budget;
  while (remaining > 0) {
    let widest = -1;
    for (let index = 0; index < widths.length; index++) {
      if (
        (widest < 0 || widths[index]! > widths[widest]!) &&
        widths[index]! > MIN_TAB_WIDTH
      )
        widest = index;
    }
    if (widest < 0) break;
    widths[widest] = widths[widest]! - 1;
    remaining--;
  }
  return widths;
}

/**
 * Lay out repository tabs in terminal columns without touching renderables.
 *
 * The + action follows the final visible tab. When the tabs do not fit, a
 * contiguous window is returned and the active tab is preferred. Long labels
 * are clipped after the window has been chosen, so every returned hit remains
 * inside the supplied terminal width.
 */
export function layoutRepositoryTabs(
  tabs: readonly RepositoryTab[],
  activeId: string | number | undefined,
  width: number,
): RepositoryTabsLayout {
  const terminal = terminalWidth(width);
  const openWidth = Math.min(OPEN_WIDTH, terminal);
  const tabBudget = Math.max(
    0,
    terminal - openWidth - (tabs.length > 0 ? TAB_GAP : 0),
  );
  const activeTabId =
    typeof activeId === "number" ? tabs[activeId]?.id : activeId;
  const natural = tabs.map((tab) => naturalTabWidth(labelFor(tab)));
  const { start, end } = visibleWindow(tabs, tabBudget, activeTabId);
  const selectedNatural = natural.slice(start, end);
  const selectedWidths = fitTabWidths(
    selectedNatural,
    Math.max(0, tabBudget - Math.max(0, selectedNatural.length - 1) * TAB_GAP),
  );
  const laidOut: RepositoryTabLayout[] = [];
  let column = 0;
  for (let index = start; index < end; index++) {
    const tab = tabs[index]!;
    const fullLabel = labelFor(tab);
    const tabWidth = selectedWidths[index - start] ?? MIN_TAB_WIDTH;
    const closeWidth = Math.min(CLOSE_WIDTH, tabWidth);
    const closeStart = column + tabWidth - closeWidth;
    const labelWidth = Math.max(0, closeStart - column - 2);
    const active = tab.id === activeTabId;
    laidOut.push({
      id: tab.id,
      path: tab.path ?? tab.root,
      ...(tab.root === undefined ? {} : { root: tab.root }),
      label: clipColumns(fullLabel, labelWidth),
      fullLabel,
      active,
      style: active ? "active" : "inactive",
      start: column,
      end: column + tabWidth,
      closeStart,
      closeEnd: column + tabWidth,
    });
    column += tabWidth;
    if (index < end - 1) column += TAB_GAP;
  }
  const openStart = Math.min(terminal, column + (laidOut.length ? TAB_GAP : 0));
  const openEnd = Math.min(terminal, openStart + openWidth);
  return {
    width: terminal,
    tabs: laidOut,
    open: { action: "open", start: openStart, end: openEnd },
    hiddenBefore: start,
    hiddenAfter: tabs.length - end,
  };
}

/** Return the action represented by a terminal column in a tab strip. */
export function repositoryTabHit(
  layout: RepositoryTabsLayout,
  column: number,
): RepositoryTabHit | undefined {
  if (!Number.isFinite(column)) return undefined;
  const x = Math.trunc(column);
  if (x < 0 || x >= layout.width) return undefined;
  if (x >= layout.open.start && x < layout.open.end) return { action: "open" };
  for (const tab of layout.tabs) {
    if (x >= tab.closeStart && x < tab.closeEnd)
      return { action: "close", tabId: tab.id };
    if (x >= tab.start && x < tab.end)
      return { action: "select", tabId: tab.id };
  }
  return undefined;
}

/** Alias with the conventional hit-testing name used by other UI models. */
export const hitTestRepositoryTabs = repositoryTabHit;

/** Move a tab before the tab currently under the pointer. */
export function reorderRepositoryTabs<T extends { id: string }>(
  tabs: readonly T[],
  movedId: string,
  targetId: string,
): T[] {
  const from = tabs.findIndex((tab) => tab.id === movedId);
  const target = tabs.findIndex((tab) => tab.id === targetId);
  if (from < 0 || target < 0 || from === target) return [...tabs];
  const reordered = [...tabs];
  const [moved] = reordered.splice(from, 1);
  if (!moved) return reordered;
  reordered.splice(target, 0, moved);
  return reordered;
}

/** Render one tab to exactly the columns reserved by its layout. */
export function repositoryTabText(tab: RepositoryTabLayout): string {
  const width = Math.max(0, tab.end - tab.start);
  if (width === 0) return "";
  const suffix = width >= 2 ? " ×" : "";
  const prefix = width >= 1 ? " " : "";
  const contentWidth = Math.max(0, width - Bun.stringWidth(prefix + suffix));
  const label = clipColumns(tab.label, contentWidth);
  return `${prefix}${label}${" ".repeat(Math.max(0, contentWidth - Bun.stringWidth(label)))}${suffix}`;
}
