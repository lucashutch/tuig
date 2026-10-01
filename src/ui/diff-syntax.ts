import { SyntaxStyle, type StyleDefinitionInput } from "@opentui/core";
import { activeTheme as theme, semanticColor } from "./theme.js";

// Foregrounds only: added/removed line backgrounds remain owned by the diff.
export const diffSyntaxStyles: Record<string, StyleDefinitionInput> = {
  default: { fg: theme.text },
  comment: { fg: "#7F848E", italic: true },
  keyword: { fg: theme.author },
  operator: { fg: theme.accentSoft },
  punctuation: { fg: theme.text },
  string: { fg: theme.added },
  character: { fg: theme.added },
  number: { fg: "#D19A66" },
  boolean: { fg: "#D19A66" },
  constant: { fg: "#D19A66" },
  function: { fg: theme.accent },
  method: { fg: theme.accent },
  type: { fg: theme.warning },
  constructor: { fg: theme.warning },
  variable: { fg: theme.text },
  property: { fg: theme.deleted },
  attribute: { fg: theme.warning },
  tag: { fg: theme.deleted },
  label: { fg: theme.author },
  module: { fg: theme.warning },
  "markup.heading": { fg: theme.accent, bold: true },
  "markup.link": { fg: theme.accentSoft, underline: true },
  "markup.raw": { fg: theme.added },
  "markup.strong": { fg: theme.text, bold: true },
  "markup.italic": { fg: theme.text, italic: true },
};

export function createDiffSyntaxStyle(): SyntaxStyle {
  const styles: Record<string, StyleDefinitionInput> = {
    default: { fg: theme.text },
    comment: { fg: theme.syntax?.comment ?? theme.muted, italic: true },
    number: { fg: theme.syntax?.number ?? theme.warning },
    boolean: { fg: theme.syntax?.number ?? theme.warning },
    constant: { fg: theme.syntax?.number ?? theme.warning },
    punctuation: { fg: theme.text },
    keyword: { fg: theme.author },
    operator: { fg: theme.accentSoft },
    string: { fg: theme.added },
    character: { fg: theme.added },
    function: { fg: theme.accent },
    method: { fg: theme.accent },
    type: { fg: theme.warning },
    constructor: { fg: theme.warning },
    variable: { fg: theme.text },
    property: { fg: theme.deleted },
    attribute: { fg: theme.warning },
    tag: { fg: theme.deleted },
    label: { fg: theme.author },
    module: { fg: theme.warning },
    "markup.heading": { fg: theme.accent, bold: true },
    "markup.link": { fg: theme.accentSoft, underline: true },
    "markup.raw": { fg: theme.added },
    "markup.strong": { fg: theme.text, bold: true },
    "markup.italic": { fg: theme.text, italic: true },
  };
  for (const [name, color] of Object.entries(theme.syntax ?? {}))
    styles[name] = { ...styles[name], fg: color };
  const aliases: Record<string, string[]> = {
    string: ["character"],
    number: ["boolean", "constant"],
    function: ["method"],
    type: ["constructor", "attribute", "module"],
    keyword: ["label"],
  };
  if (theme.semantic) aliases.variable = ["property"];
  for (const [name, captures] of Object.entries(aliases)) {
    const color = theme.syntax?.[name];
    if (color)
      for (const capture of captures)
        styles[capture] = { ...styles[capture], fg: color };
  }
  for (const [capture, token] of Object.entries({
    "markup.heading": "heading",
    "markup.link": "link",
    "markup.raw": "code",
    "markup.strong": "strong",
    "markup.italic": "emphasis",
  })) {
    styles[capture] = {
      ...styles[capture],
      fg: semanticColor(
        theme,
        `markdown.${token}`,
        styles[capture]?.fg as string,
      ),
    };
  }
  return SyntaxStyle.fromStyles(styles);
}
