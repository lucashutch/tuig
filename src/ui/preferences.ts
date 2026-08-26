import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type LayoutPreferences = {
  leftWidth?: number;
  detailsWidth?: number;
  unstagedHeight?: number;
  composerHeight?: number;
  sidebarHeights?: Partial<
    Record<"local" | "remote" | "submodules" | "stashes" | "worktrees", number>
  >;
  sidebarCollapsed?: Partial<
    Record<"local" | "remote" | "submodules" | "stashes" | "worktrees", boolean>
  >;
};

export function layoutPreferencesPath(env = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "tuig", "layout.json");
}

export function parseLayoutPreferences(value: unknown): LayoutPreferences {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const positive = (key: string) => {
    const number = input[key];
    return typeof number === "number" && Number.isFinite(number) && number >= 0
      ? number
      : undefined;
  };
  const sections = [
    "local",
    "remote",
    "submodules",
    "stashes",
    "worktrees",
  ] as const;
  const sectionNumbers = (key: string) => {
    const values = input[key] as Record<string, unknown> | undefined;
    return Object.fromEntries(
      sections.map((section) => {
        const number = values?.[section];
        return [
          section,
          typeof number === "number" && Number.isFinite(number) && number >= 0
            ? number
            : undefined,
        ];
      }),
    );
  };
  const sectionBooleans = Object.fromEntries(
    sections.map((section) => [
      section,
      typeof (input.sidebarCollapsed as Record<string, unknown> | undefined)?.[
        section
      ] === "boolean"
        ? (input.sidebarCollapsed as Record<string, boolean>)[section]
        : undefined,
    ]),
  );
  const sidebarHeights =
    typeof input.sidebarHeights === "object" && input.sidebarHeights
      ? sectionNumbers("sidebarHeights")
      : undefined;
  const sidebarCollapsed =
    typeof input.sidebarCollapsed === "object" && input.sidebarCollapsed
      ? sectionBooleans
      : undefined;
  return {
    leftWidth: positive("leftWidth"),
    detailsWidth: positive("detailsWidth"),
    unstagedHeight: positive("unstagedHeight"),
    composerHeight: positive("composerHeight"),
    ...(sidebarHeights ? { sidebarHeights } : {}),
    ...(sidebarCollapsed ? { sidebarCollapsed } : {}),
  };
}

export async function loadLayoutPreferences(
  path = layoutPreferencesPath(),
): Promise<LayoutPreferences> {
  try {
    return parseLayoutPreferences(await Bun.file(path).json());
  } catch {
    return {};
  }
}

export async function saveLayoutPreferences(
  preferences: LayoutPreferences,
  path = layoutPreferencesPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(preferences, null, 2)}\n`);
}
