// OpenCode V2 semantics: anomalyco/opencode 8b24fc8c2af625c8bffa04150f8d0aa25264bed3.
// See themes/LICENSE for the upstream MIT notice.
import { oneDarkTheme, type Theme } from "./theme";

export type ThemeMode = "dark" | "light";
type Node = Record<string, unknown>;
const states = ["hovered", "focused", "pressed", "selected", "disabled"];
const record = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const syntaxTokens = [
  "comment",
  "keyword",
  "function",
  "variable",
  "string",
  "number",
  "type",
  "operator",
  "punctuation",
];
const markdownTokens = [
  "text",
  "heading",
  "link",
  "linkText",
  "code",
  "blockQuote",
  "emphasis",
  "strong",
  "horizontalRule",
  "listItem",
  "listEnumeration",
  "image",
  "imageText",
  "codeBlock",
];
const hex = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
function read(source: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        record(node) && Object.hasOwn(node, key) ? node[key] : undefined,
      source,
    );
}
function validateBase(base: Node): void {
  const paths = [
    "text.base",
    "text.muted",
    "background.base",
    "background.raised.base",
    "background.raised.high",
    "background.raised.max",
    "border.base",
    "scrollbar.base",
    "diff.text.added",
    "diff.text.removed",
    "diff.text.context",
    "diff.text.hunkHeader",
    "diff.background.added",
    "diff.background.removed",
    "diff.background.context",
    "diff.highlight.added",
    "diff.highlight.removed",
    "diff.lineNumber.text",
    "diff.lineNumber.background.added",
    "diff.lineNumber.background.removed",
  ];
  for (const group of ["text", "background"]) {
    paths.push(`${group}.formfield.base`);
    for (const variant of ["primary", "secondary", "destructive"])
      paths.push(`${group}.action.${variant}.base`);
    for (const kind of ["error", "warning", "success", "info"])
      paths.push(`${group}.feedback.${kind}.base`);
  }
  for (const path of paths) {
    const value = read(base, path);
    if (
      typeof value !== "string" ||
      !(hex.test(value) || value === "transparent" || /^\$.+/.test(value))
    )
      throw new Error(`Invalid theme: missing or invalid base.${path}`);
  }
  for (const [group, tokens] of [
    ["syntax", syntaxTokens],
    ["markdown", markdownTokens],
  ] as const)
    for (const token of tokens) {
      const value = read(base, `${group}.${token}`);
      if (
        typeof value !== "string" ||
        !(
          hex.test(value) ||
          /^\$hue\..+\.(100|200|300|400|500|600|700|800|900)$/.test(value)
        )
      )
        throw new Error(
          `Invalid theme: missing or invalid base.${group}.${token}`,
        );
    }
  validateCategorical(base.categorical);
}
function validateCategorical(value: unknown): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((name) => typeof name !== "string" || name.length === 0)
  )
    throw new Error(
      "Invalid categorical hues: expected a nonempty list of hue names",
    );
}
function validateMode(mode: unknown, name: string): void {
  if (!record(mode) || !record(mode.hue))
    throw new Error(`Invalid theme: ${name} must provide hue scales`);
  for (const semantic of ["accent", "interactive", "neutral"])
    if (!Object.hasOwn(mode.hue, semantic) || mode.hue[semantic] === undefined)
      throw new Error(`Missing required semantic hue: ${name}.${semantic}`);
  for (const [hueName, value] of Object.entries(mode.hue)) {
    if (!hueName) throw new Error("Invalid empty hue name");
    if (typeof value === "string" && /^\$hue\..+$/.test(value)) continue;
    if (!record(value) || Object.keys(value).length !== 9)
      throw new Error(`Invalid hue scale: ${name}.${hueName}`);
    for (let step = 100; step <= 900; step += 100)
      if (typeof value[step] !== "string" || !hex.test(value[step] as string))
        throw new Error(`Invalid hue color: ${name}.${hueName}.${step}`);
  }
  if (mode.categorical !== undefined) validateCategorical(mode.categorical);
  for (const group of ["syntax", "markdown"])
    if (record(mode[group]))
      for (const [token, value] of Object.entries(mode[group])) {
        if (
          typeof value !== "string" ||
          !(
            hex.test(value) ||
            /^\$hue\..+\.(100|200|300|400|500|600|700|800|900)$/.test(value)
          )
        )
          throw new Error(`Invalid ${name}.${group}.${token}`);
      }
}
export function mergeTheme(...values: unknown[]): Node {
  const result: Node = Object.create(null) as Node;
  for (const value of values)
    if (record(value))
      for (const [key, item] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new Error(`Unsafe theme key: ${key}`);
        if (item !== undefined)
          result[key] = record(item) ? mergeTheme(result[key], item) : item;
      }
  return result;
}
function expand(value: Node, path = ""): Node {
  const result = mergeTheme(value);
  for (const [key, item] of Object.entries(result))
    if (record(item)) result[key] = expand(item, path ? `${path}.${key}` : key);
  if (
    typeof result.base === "string" &&
    /^(text|background)\.(action\.[^.]+|formfield)$/.test(path)
  ) {
    for (const state of states) result[`$${state}`] ??= `$${path}.base`;
  }
  if (path === "text" || /^text\.feedback\.[^.]+$/.test(path))
    result.muted ??= result.base ? `$${path}.base` : undefined;
  return result;
}
export interface ResolvedThemeDocument {
  categorical: string[];
  tokens: Node;
  dialog: Node;
  mode: ThemeMode;
}
export function resolveThemeDocument(
  input: unknown,
  mode: ThemeMode = "light",
): ResolvedThemeDocument {
  if (!record(input) || !record(input.base))
    throw new Error("Invalid theme: expected base and at least one mode");
  validateBase(input.base);
  for (const name of ["light", "dark"])
    if (input[name] !== undefined) validateMode(input[name], name);
  const selected = record(input[mode])
    ? mode
    : record(input.light)
      ? "light"
      : "dark";
  if (!record(input[selected]))
    throw new Error("Theme must provide at least one mode");
  const merged = mergeTheme(input.base, input[selected]);
  if (!record(merged.hue))
    throw new Error("Invalid theme: mode must provide hue scales");
  const hues = merged.hue;
  function hue(name: string, stack: string[] = []): Node {
    if (stack.includes(name))
      throw new Error(
        `Circular hue reference: ${[...stack, name].join(" -> ")}`,
      );
    const value = hues[name];
    if (typeof value === "string") {
      if (!value.startsWith("$hue."))
        throw new Error(`Invalid hue alias: ${value}`);
      return hue(value.slice(5), [...stack, name]);
    }
    if (!record(value)) throw new Error(`Missing hue: ${name}`);
    if (Object.keys(value).length !== 9)
      throw new Error(`Invalid hue scale: ${name}`);
    for (let step = 100; step <= 900; step += 100)
      if (
        typeof value[step] !== "string" ||
        !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(
          value[step] as string,
        )
      )
        throw new Error(`Invalid hue color: ${name}.${step}`);
    return value;
  }
  merged.hue = Object.fromEntries(
    Object.keys(hues).map((name) => [name, hue(name)]),
  );
  if (
    !Array.isArray(merged.categorical) ||
    merged.categorical.length === 0 ||
    merged.categorical.some(
      (name) => typeof name !== "string" || !record((merged.hue as Node)[name]),
    )
  )
    throw new Error("Invalid categorical hues");
  const overrides = merged["@dialog"];
  const categorical = (merged.categorical as string[]).map(
    (name) =>
      (merged.hue as Record<string, Record<string, string>>)[name]?.[
        "200"
      ] as string,
  );
  for (const group of [
    "text",
    "background",
    "border",
    "scrollbar",
    "diff",
    "syntax",
    "markdown",
  ])
    if (!record(merged[group]))
      throw new Error(`Invalid theme: missing ${group}`);
  delete merged["@dialog"];
  delete merged.categorical;
  const base = expand(merged);
  function resolve(source: Node): Node {
    function walk(value: unknown, stack: string[] = []): unknown {
      if (record(value))
        return Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [
              states.includes(k.slice(1)) && k.startsWith("$") ? k.slice(1) : k,
              walk(v, stack),
            ]),
        );
      if (typeof value !== "string") throw new Error("Invalid theme color");
      if (
        value === "transparent" ||
        /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
      )
        return value;
      if (!value.startsWith("$"))
        throw new Error(`Invalid theme color: ${value}`);
      const target = value.slice(1);
      if (stack.includes(target))
        throw new Error(
          `Circular theme reference: ${[...stack, target].join(" -> ")}`,
        );
      const hueTarget =
        /^hue\.(.+)\.(100|200|300|400|500|600|700|800|900)$/.exec(target);
      const scales = source.hue;
      const scale =
        hueTarget && record(scales) && Object.hasOwn(scales, hueTarget[1]!)
          ? scales[hueTarget[1]!]
          : undefined;
      const found = hueTarget
        ? record(scale)
          ? scale[hueTarget[2]!]
          : undefined
        : read(source, target);
      if (found === undefined)
        throw new Error(`Theme reference ${value} was not found`);
      const resolved = walk(found, [...stack, target]);
      if (typeof resolved !== "string")
        throw new Error(`Theme reference ${value} is not a color`);
      return resolved;
    }
    return walk(source) as Node;
  }
  const surface = record(overrides) ? expand(overrides) : {};
  const dialog = mergeTheme(base, surface);
  for (const group of ["text", "background"]) {
    const baseActions = record(base[group]) ? base[group].action : undefined;
    const surfaceActions = record(surface[group])
      ? surface[group].action
      : undefined;
    if (!record(baseActions) || !record(surfaceActions)) continue;
    const actions = (dialog[group] as Node).action as Node;
    for (const [variant, override] of Object.entries(surfaceActions)) {
      if (!record(override) || !record(baseActions[variant])) continue;
      const original = baseActions[variant] as Node;
      actions[variant] = Object.fromEntries(
        ["base", ...states.map((state) => `$${state}`)].map((key) => [
          key,
          override[key] ?? override.base ?? original[key] ?? original.base,
        ]),
      );
    }
  }
  return {
    tokens: resolve(base),
    dialog: resolve(dialog),
    mode: selected,
    categorical,
  };
}
export function themeFromDocument(input: unknown, mode: ThemeMode): Theme {
  const { tokens, dialog, categorical } = resolveThemeDocument(input, mode);
  const color = (path: string): string => {
    const value = path
      .split(".")
      .reduce<unknown>(
        (node, key) => (record(node) ? node[key] : undefined),
        tokens,
      );
    if (typeof value !== "string")
      throw new Error(`Invalid theme: missing ${path}`);
    return value;
  };
  for (const group of ["text", "background"]) {
    color(`${group}.base`);
    for (const variant of ["primary", "secondary", "destructive"])
      color(`${group}.action.${variant}.base`);
    color(`${group}.formfield.base`);
    for (const kind of ["error", "warning", "success", "info"])
      color(`${group}.feedback.${kind}.base`);
  }
  for (const path of [
    "scrollbar.base",
    "background.raised.max",
    "diff.text.context",
    "diff.text.hunkHeader",
    "diff.background.context",
    "diff.highlight.added",
    "diff.highlight.removed",
    "diff.lineNumber.text",
    "diff.lineNumber.background.added",
    "diff.lineNumber.background.removed",
  ])
    color(path);
  for (const token of [
    "comment",
    "keyword",
    "function",
    "variable",
    "string",
    "number",
    "type",
    "operator",
    "punctuation",
  ])
    color(`syntax.${token}`);
  return {
    ...oneDarkTheme,
    graph: categorical,
    semantic: { tokens, dialog },
    bg: color("background.base"),
    panel: color("background.raised.base"),
    panelRaised: color("background.raised.high"),
    border: color("border.base"),
    text: color("text.base"),
    muted: color("text.muted"),
    accent: color("text.action.primary.base"),
    accentSoft: color("text.feedback.info.base"),
    selected: color("background.raised.high"),
    added: color("text.feedback.success.base"),
    deleted: color("text.feedback.error.base"),
    warning: color("text.feedback.warning.base"),
    author: color("syntax.keyword"),
    divider: color("border.base"),
    // The bundled action tokens are transparent or equal to the panel, so
    // hover and pressed use surfaces that stay visible on every pane.
    hover: color("background.raised.high"),
    pressed: color("border.base"),
    focusRing: color("text.action.primary.base"),
    folder: color("text.action.primary.base"),
    folderBg: color("background.raised.base"),
    diffAddedBg: color("diff.background.added"),
    diffRemovedBg: color("diff.background.removed"),
    syntax: tokens.syntax as Record<string, string>,
    diff: tokens.diff as Node,
  };
}
