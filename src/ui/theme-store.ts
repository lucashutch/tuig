import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import opencode from "./themes/opencode.json";
import { oneDarkTheme, type Theme } from "./theme";
import { themeFromDocument, type ThemeMode } from "./theme-resolver";

export interface ThemeSelection {
  name: string;
  mode: ThemeMode | "system";
}
export interface ThemeEntry {
  name: string;
  source: string;
}
export interface ThemeCatalog {
  entries: ThemeEntry[];
  errors: string[];
  resolve(name: string, mode: ThemeMode): Theme;
}
function validateName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    /[/\\]/u.test(name) ||
    [...name].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new Error(
      "Invalid theme name: use a filename without paths or control characters",
    );
}
function configRoot(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "tuig",
  );
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function selection(value: unknown): ThemeSelection {
  if (!value || typeof value !== "object")
    throw new Error("Invalid theme preferences: expected name and mode");
  const { name, mode } = value as ThemeSelection;
  validateName(name);
  if (!["dark", "light", "system"].includes(mode))
    throw new Error("Invalid theme mode: expected dark, light, or system");
  return { name, mode };
}
export async function loadThemePreferences(): Promise<ThemeSelection> {
  try {
    return selection(
      JSON.parse(await readFile(join(configRoot(), "theme.json"), "utf8")),
    );
  } catch (error) {
    if (missing(error)) return { name: "one-dark", mode: "system" };
    throw new Error(`Cannot load theme preferences: ${String(error)}`, {
      cause: error,
    });
  }
}
export async function saveThemePreferences(
  value: ThemeSelection,
): Promise<void> {
  const valid = selection(value);
  const root = configRoot();
  await mkdir(root, { recursive: true });
  const temporary = join(
    root,
    `.theme-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  await writeFile(temporary, JSON.stringify(valid, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, join(root, "theme.json"));
}
export async function loadThemeCatalog(
  repositoryRoot?: string,
): Promise<ThemeCatalog> {
  const documents = new Map<
    string,
    { source: string; document?: unknown; error?: string }
  >([
    ["one-dark", { source: "builtin" }],
    ["opencode", { source: "builtin", document: opencode }],
  ]);
  const directories = [join(configRoot(), "themes")];
  if (repositoryRoot) {
    const ancestors: string[] = [];
    let current = resolve(repositoryRoot);
    for (;;) {
      ancestors.unshift(join(current, ".tuig", "themes"));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    directories.push(...ancestors);
  }
  const errors: string[] = [];
  for (const directory of directories) {
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (missing(error)) continue;
      errors.push(`${directory}: ${String(error)}`);
      continue;
    }
    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5),
        source = join(directory, file);
      try {
        validateName(name);
        const document: unknown = JSON.parse(await readFile(source, "utf8"));
        themeFromDocument(document, "dark");
        themeFromDocument(document, "light");
        documents.set(name, { source, document });
      } catch (error) {
        const message = `${source}: ${String(error)}`;
        errors.push(message);
        documents.set(name, { source, error: message });
      }
    }
  }
  return {
    entries: [...documents].map(([name, value]) => ({
      name,
      source: value.source,
    })),
    errors,
    resolve(name, mode) {
      validateName(name);
      if (mode !== "dark" && mode !== "light")
        throw new Error(`Invalid theme mode: ${mode}`);
      const entry = documents.get(name);
      if (!entry) throw new Error(`Unknown theme: ${name}`);
      if (entry.error) throw new Error(entry.error);
      return entry.document
        ? themeFromDocument(entry.document, mode)
        : { ...oneDarkTheme, graph: [...oneDarkTheme.graph] };
    },
  };
}
