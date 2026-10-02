export interface Theme {
  semantic?: {
    tokens: Readonly<Record<string, unknown>>;
    dialog: Readonly<Record<string, unknown>>;
  };
  bg: string;
  panel: string;
  panelRaised: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  selected: string;
  added: string;
  deleted: string;
  warning: string;
  author: string;
  divider: string;
  /** Shared interaction colors: hover and pressed backgrounds, focus accent. */
  hover: string;
  pressed: string;
  focusRing: string;
  folder: string;
  folderBg: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  graph: readonly string[];
  syntax?: Readonly<Record<string, string>>;
  diff?: Readonly<Record<string, unknown>>;
}

export const oneDarkTheme: Theme = {
  bg: "#282C34",
  panel: "#21252B",
  panelRaised: "#2C313A",
  border: "#5C6370",
  text: "#ABB2BF",
  muted: "#5C6370",
  accent: "#61AFEF",
  accentSoft: "#56B6C2",
  selected: "#3E4451",
  added: "#98C379",
  deleted: "#E06C75",
  warning: "#E5C07B",
  author: "#C678DD",
  divider: "#2B5B61",
  hover: "#353B45",
  pressed: "#315878",
  focusRing: "#61AFEF",
  folder: "#61AFEF",
  folderBg: "#2C313A",
  diffAddedBg: "#30402F",
  diffRemovedBg: "#462C31",
  graph: ["#61AFEF", "#C678DD", "#E5C07B", "#98C379", "#E06C75", "#56B6C2"],
  syntax: {
    comment: "#7F848E",
    keyword: "#C678DD",
    function: "#61AFEF",
    variable: "#ABB2BF",
    string: "#98C379",
    number: "#D19A66",
    type: "#E5C07B",
    operator: "#56B6C2",
    punctuation: "#ABB2BF",
  },
};

export const activeTheme: Theme = {
  ...oneDarkTheme,
  graph: [...oneDarkTheme.graph],
};

export function setActiveTheme(theme: Theme): void {
  const next = { ...theme, graph: [...theme.graph] };
  for (const key of Object.keys(activeTheme))
    delete (activeTheme as unknown as Record<string, unknown>)[key];
  Object.assign(activeTheme, next);
}

export type ThemeState =
  | "disabled"
  | "pressed"
  | "focused"
  | "selected"
  | "hovered";

export function semanticColor(
  theme: Theme,
  path: string,
  fallback: string,
  options?: {
    surface?: "dialog";
    states?: Partial<Record<ThemeState, boolean>>;
  },
): string {
  const source =
    options?.surface === "dialog"
      ? theme.semantic?.dialog
      : theme.semantic?.tokens;
  const value = path.split(".").reduce<unknown>((node, key) => {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key))
      return undefined;
    return (node as Record<string, unknown>)[key];
  }, source);
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return fallback;
  const colors = value as Record<string, unknown>;
  const state = (
    ["disabled", "pressed", "focused", "selected", "hovered"] as const
  ).find((state) => options?.states?.[state]);
  const color = colors[state ?? "base"];
  return typeof color === "string" ? color : fallback;
}

/**
 * Background for any interactive element. Pressed beats selected, and selected
 * beats hovered so a selected row keeps its color under the pointer.
 */
export function interactionBackground(
  theme: Theme,
  base: string,
  states: { pressed?: boolean; selected?: boolean; hovered?: boolean },
): string {
  if (states.pressed) return theme.pressed;
  if (states.selected) return theme.selected;
  if (states.hovered) return theme.hover;
  return base;
}
