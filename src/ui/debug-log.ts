import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const enabled = Boolean(process.env.TUIG_DEBUG);

function logPath() {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "tuig", "debug.log");
}

/**
 * Append a line to the debug log when TUIG_DEBUG is set.
 *
 * The TUI owns stdout and stderr, so failures that would otherwise be printed
 * go to a file instead. Writes are fire-and-forget; a broken log must never
 * take down the paint path.
 */
export function debugLog(scope: string, message: string, error?: unknown) {
  if (!enabled) return;
  const detail =
    error instanceof Error
      ? `: ${error.message}`
      : error === undefined
        ? ""
        : `: ${String(error)}`;
  const line = `${new Date().toISOString()} [${scope}] ${message}${detail}\n`;
  const path = logPath();
  void mkdir(dirname(path), { recursive: true })
    .then(() => appendFile(path, line))
    .catch(() => undefined);
}
