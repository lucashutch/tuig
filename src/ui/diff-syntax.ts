import { SyntaxStyle, type StyleDefinitionInput } from "@opentui/core";
import { oneDarkTheme as theme } from "./theme.js";

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
  return SyntaxStyle.fromStyles(diffSyntaxStyles);
}
