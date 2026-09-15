import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type SessionPreferences = {
  repositories: string[];
  activeRepository?: string;
  submodules?: Record<string, { root: string; path: string }>;
};

export function sessionPreferencesPath(env = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "tuig", "session.json");
}

export function parseSessionPreferences(value: unknown): SessionPreferences {
  if (!value || typeof value !== "object") return { repositories: [] };
  const input = value as Record<string, unknown>;
  const repositories = Array.isArray(input.repositories)
    ? [
        ...new Set(
          input.repositories.filter(
            (path): path is string =>
              typeof path === "string" && path.length > 0,
          ),
        ),
      ]
    : [];
  const activeRepository =
    typeof input.activeRepository === "string" &&
    repositories.includes(input.activeRepository)
      ? input.activeRepository
      : undefined;
  const rawSubmodules =
    input.submodules && typeof input.submodules === "object"
      ? (input.submodules as Record<string, unknown>)
      : {};
  const submodules = Object.fromEntries(
    Object.entries(rawSubmodules).filter(
      (entry): entry is [string, { root: string; path: string }] => {
        const [repository, value] = entry;
        if (
          !repositories.includes(repository) ||
          !value ||
          typeof value !== "object"
        )
          return false;
        const relation = value as Record<string, unknown>;
        return (
          typeof relation.root === "string" && typeof relation.path === "string"
        );
      },
    ),
  );
  return {
    repositories,
    ...(activeRepository ? { activeRepository } : {}),
    ...(Object.keys(submodules).length ? { submodules } : {}),
  };
}

export async function loadSessionPreferences(
  path = sessionPreferencesPath(),
): Promise<SessionPreferences> {
  try {
    return parseSessionPreferences(await Bun.file(path).json());
  } catch {
    return { repositories: [] };
  }
}

export async function saveSessionPreferences(
  preferences: SessionPreferences,
  path = sessionPreferencesPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(preferences, null, 2)}\n`);
}
