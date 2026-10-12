import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Saved history column layout. Widths are cells and clamp to the pane on use. */
export type HistoryColumnPreferences = {
  branchWidth?: number;
  graphWidth?: number;
  committerWidth?: number;
  showCommitter?: boolean;
  showSha?: boolean;
  showPr?: boolean;
};

const MAX_SAVED_WIDTH = 1000;

const SAVED_SIDEBAR_SECTIONS = [
  "local",
  "pullRequests",
  "remote",
  "submodules",
  "stashes",
  "worktrees",
] as const;
type SavedSidebarSection = (typeof SAVED_SIDEBAR_SECTIONS)[number];

export type LayoutPreferences = {
  /** Whether remote author avatars may be fetched and displayed. */
  avatarsEnabled?: boolean;
  /** Preferred diff layout. Narrow panes can temporarily fall back to inline. */
  diffView?: "inline" | "side-by-side";
  /** Minutes between automatic `git fetch --prune` runs. Zero disables it. */
  remoteFetchIntervalMinutes?: number;
  leftWidth?: number;
  detailsWidth?: number;
  leftCollapsed?: boolean;
  detailsCollapsed?: boolean;
  historyColumns?: HistoryColumnPreferences;
  unstagedHeight?: number;
  composerHeight?: number;
  sidebarHeights?: Partial<Record<SavedSidebarSection, number>>;
  sidebarCollapsed?: Partial<Record<SavedSidebarSection, boolean>>;
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
  const columnInput =
    input.historyColumns && typeof input.historyColumns === "object"
      ? (input.historyColumns as Record<string, unknown>)
      : undefined;
  const width = (key: string) => {
    const number = columnInput?.[key];
    return typeof number === "number" &&
      Number.isFinite(number) &&
      number >= 1 &&
      number <= MAX_SAVED_WIDTH
      ? Math.round(number)
      : undefined;
  };
  const flag = (key: string) =>
    typeof columnInput?.[key] === "boolean"
      ? (columnInput[key] as boolean)
      : undefined;
  const historyColumns = columnInput
    ? {
        branchWidth: width("branchWidth"),
        graphWidth: width("graphWidth"),
        committerWidth: width("committerWidth"),
        showCommitter: flag("showCommitter"),
        showSha: flag("showSha"),
        showPr: flag("showPr"),
      }
    : undefined;
  const sections = SAVED_SIDEBAR_SECTIONS;
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
    avatarsEnabled:
      typeof input.avatarsEnabled === "boolean"
        ? input.avatarsEnabled
        : undefined,
    diffView:
      input.diffView === "inline" || input.diffView === "side-by-side"
        ? input.diffView
        : undefined,
    remoteFetchIntervalMinutes: positive("remoteFetchIntervalMinutes"),
    leftWidth: positive("leftWidth"),
    detailsWidth: positive("detailsWidth"),
    leftCollapsed:
      typeof input.leftCollapsed === "boolean"
        ? input.leftCollapsed
        : undefined,
    detailsCollapsed:
      typeof input.detailsCollapsed === "boolean"
        ? input.detailsCollapsed
        : undefined,
    ...(historyColumns ? { historyColumns } : {}),
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

let saveQueue: Promise<unknown> = Promise.resolve();

/**
 * Merges the defined preferences into the existing file. Keys that Tuig does
 * not manage, and keys left undefined here, keep their stored values. Writes
 * go to a temporary file first so a crash cannot leave a truncated file.
 */
export function saveLayoutPreferences(
  preferences: LayoutPreferences,
  path = layoutPreferencesPath(),
): Promise<void> {
  const run = async () => {
    let existing: Record<string, unknown> = {};
    try {
      const stored: unknown = await Bun.file(path).json();
      if (stored && typeof stored === "object" && !Array.isArray(stored))
        existing = stored as Record<string, unknown>;
    } catch {
      // A missing or malformed file is replaced.
    }
    const defined = Object.fromEntries(
      Object.entries(preferences).filter(([, value]) => value !== undefined),
    );
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ ...existing, ...defined }, null, 2)}\n`,
      );
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  const result = saveQueue.then(run, run);
  saveQueue = result.catch(() => undefined);
  return result;
}
