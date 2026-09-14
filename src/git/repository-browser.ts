import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** A visible child directory that can be displayed and selected by a picker. */
export interface DirectorySuggestion {
  name: string;
  /** Absolute path to the directory, ready for opening. */
  path: string;
}

function sortDirectoryNames(left: string, right: string): number {
  return (
    left.localeCompare(right, undefined, { sensitivity: "base" }) ||
    left.localeCompare(right)
  );
}

/**
 * Resolve the directory being completed and the partial final path component.
 * A trailing separator means the complete path names the directory to inspect;
 * otherwise its parent is inspected and its basename is the filter.
 */
function completionLocation(
  typedPath: string,
  cwd: string,
): { directory: string; partial: string } {
  if (typedPath.length === 0) return { directory: resolve(cwd), partial: "" };
  const absolutePath = isAbsolute(typedPath)
    ? resolve(typedPath)
    : resolve(cwd, typedPath);
  const hasTrailingSeparator = typedPath.endsWith("/");
  if (hasTrailingSeparator) return { directory: absolutePath, partial: "" };
  return { directory: dirname(absolutePath), partial: basename(absolutePath) };
}

/**
 * List non-hidden child directories matching the final component of a path.
 *
 * `typedPath` may be absolute or relative to `cwd`. Missing and unreadable
 * parents produce no suggestions, which keeps an in-progress path edit from
 * turning a picker into an error state.
 */
export async function suggestDirectories(
  typedPath = "",
  cwd = process.cwd(),
): Promise<DirectorySuggestion[]> {
  const { directory, partial } = completionLocation(typedPath, resolve(cwd));
  const wanted = partial.toLowerCase();
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name.toLowerCase().startsWith(wanted),
    )
    .sort((left, right) => sortDirectoryNames(left.name, right.name))
    .map((entry) => ({ name: entry.name, path: join(directory, entry.name) }));
}

/** Kept as a descriptive alias for callers that use list terminology. */
export const listDirectorySuggestions = suggestDirectories;
