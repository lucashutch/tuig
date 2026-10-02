import opencode from "./opencode.json";
import palettes from "./palettes.json";

type Palette = Record<string, string>;

// Adapt OpenCode's bundled palettes to the V2 semantic token tree.
// Custom theme discovery remains V2-only.
function mode(palette: Palette) {
  const mix = (foreground: string, background: string, amount: number) => {
    const channels = [1, 3, 5].map((offset) =>
      Math.round(
        parseInt(foreground.slice(offset, offset + 2), 16) * amount +
          parseInt(background.slice(offset, offset + 2), 16) * (1 - amount),
      )
        .toString(16)
        .padStart(2, "0"),
    );
    return `#${channels.join("")}`;
  };
  const scale = (color: string) =>
    Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        (index + 1) * 100,
        mix(color, palette.background!, (9 - index) / 9),
      ]),
    );
  const hue = {
    neutral: {
      100: palette.text,
      200: palette.text,
      300: mix(palette.text!, palette.background!, 0.8),
      400: palette.textMuted,
      500: palette.border,
      600: palette.backgroundElement,
      700: palette.backgroundPanel,
      800: palette.background,
      900: palette.background,
    },
    gray: scale(palette.text!),
    cyan: scale(palette.syntaxType!),
    interactive: scale(palette.primary!),
    accent: scale(palette.accent!),
    blue: scale(palette.primary!),
    purple: scale(palette.secondary!),
    green: scale(palette.success!),
    orange: scale(palette.warning!),
    red: scale(palette.error!),
  };
  const feedback = Object.fromEntries(
    ["error", "warning", "success", "info"].map((kind) => [
      kind,
      { base: palette[kind] },
    ]),
  );
  const tokens = {
    text: {
      base: palette.text,
      muted: palette.textMuted,
      feedback,
    },
    background: {
      base: palette.background,
      raised: {
        base: palette.backgroundPanel,
        high: palette.backgroundElement,
        max: palette.backgroundElement,
      },
    },
    border: { base: palette.border },
    markdown: Object.fromEntries(
      Object.entries({
        text: "Text",
        heading: "Heading",
        link: "Link",
        linkText: "LinkText",
        code: "Code",
        blockQuote: "BlockQuote",
        emphasis: "Emph",
        strong: "Strong",
        horizontalRule: "HorizontalRule",
        listItem: "ListItem",
        listEnumeration: "ListEnumeration",
        image: "Image",
        imageText: "ImageText",
        codeBlock: "CodeBlock",
      }).map(([token, source]) => [token, palette[`markdown${source}`]]),
    ),
    syntax: Object.fromEntries(
      [
        "comment",
        "keyword",
        "function",
        "string",
        "number",
        "type",
        "operator",
        "variable",
        "punctuation",
      ].map((token) => [
        token,
        palette[`syntax${token[0]!.toUpperCase()}${token.slice(1)}`],
      ]),
    ),
    diff: {
      text: {
        added: palette.diffAdded,
        removed: palette.diffRemoved,
        context: palette.diffContext,
        hunkHeader: palette.diffHunkHeader,
      },
      background: {
        added: palette.diffAddedBg,
        removed: palette.diffRemovedBg,
        context: palette.diffContextBg,
      },
      highlight: {
        added: palette.diffHighlightAdded,
        removed: palette.diffHighlightRemoved,
      },
      lineNumber: {
        text: palette.diffLineNumber,
        background: {
          added: palette.diffAddedLineNumberBg,
          removed: palette.diffRemovedLineNumberBg,
        },
      },
    },
  };
  return {
    hue,
    ...tokens,
    "@dialog": {
      ...tokens,
      background: { ...tokens.background, base: "$background.raised.base" },
    },
  };
}

export const builtinThemeDocuments = Object.fromEntries(
  Object.entries(palettes).map(([name, palette]) => [
    name,
    {
      base: opencode.base,
      dark: mode(palette.dark),
      light: mode(palette.light),
    },
  ]),
);
