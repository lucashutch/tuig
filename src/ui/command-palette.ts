export type CommandCategory =
  | "Repository"
  | "Changes"
  | "Navigation"
  | "View"
  | "Settings";

export interface PaletteCommand {
  id: string;
  title: string;
  category: CommandCategory;
  keywords?: readonly string[];
  shortcut?: string;
  enabled?: boolean;
  disabledReason?: string;
  run(): void | Promise<void>;
}

export interface PaletteMatch {
  command: PaletteCommand;
  score: number;
}

const CATEGORY_ORDER: readonly CommandCategory[] = [
  "Repository",
  "Changes",
  "Navigation",
  "View",
  "Settings",
];

const normalize = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function subsequenceScore(query: string, value: string): number | undefined {
  let at = 0;
  let gaps = 0;
  for (const character of query) {
    const found = value.indexOf(character, at);
    if (found < 0) return undefined;
    gaps += found - at;
    at = found + 1;
  }
  return 300 - gaps;
}

/** Rank commands without hiding unavailable actions, so the palette teaches scope. */
export function commandMatches(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteMatch[] {
  const normalized = normalize(query);
  const tokens = normalized.split(" ").filter(Boolean);
  return commands
    .map((command, index) => {
      if (!normalized) {
        const category = CATEGORY_ORDER.indexOf(command.category);
        return { command, score: 10_000 - category * 1_000 - index };
      }
      const title = normalize(command.title);
      const words = title.split(" ");
      const searchable = normalize(
        [command.title, command.category, ...(command.keywords ?? [])].join(
          " ",
        ),
      );
      let score = 0;
      for (const token of tokens) {
        if (title === token) score += 1_000;
        else if (title.startsWith(token)) score += 800;
        else if (words.some((word) => word.startsWith(token))) score += 650;
        else if (searchable.includes(token)) score += 500;
        else {
          const fuzzy = subsequenceScore(token, searchable);
          if (fuzzy === undefined) return undefined;
          score += fuzzy;
        }
      }
      return { command, score: score * 1_000 - index };
    })
    .filter((match): match is PaletteMatch => match !== undefined)
    .sort((a, b) => b.score - a.score);
}

export function nextEnabledCommand(
  matches: readonly PaletteMatch[],
  current: number,
  delta: number,
): number {
  if (matches.length === 0) return -1;
  let index = current;
  while (true) {
    index += delta;
    if (index < 0 || index >= matches.length)
      return matches[current]?.command.enabled !== false ? current : -1;
    if (matches[index]?.command.enabled !== false) return index;
  }
}

export function clampPaletteViewport(
  selected: number,
  start: number,
  rows: number,
  count: number,
): number {
  const maximum = Math.max(0, count - rows);
  if (selected < start) return Math.max(0, selected);
  if (selected >= start + rows) return Math.min(maximum, selected - rows + 1);
  return Math.min(maximum, Math.max(0, start));
}
