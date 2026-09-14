#!/usr/bin/env bun
import { createGitRepository, NotGitRepositoryError } from "./git/index.js";
import { runTuig } from "./ui/runtime.js";
import { HELP, VERSION, parseArgs } from "./cli.js";
import { updateTuig } from "./update.js";
import { loadSessionPreferences } from "./ui/session-preferences.js";

try {
  const action = parseArgs(process.argv.slice(2));
  if (action.kind === "help") {
    console.log(HELP);
  } else if (action.kind === "version") {
    console.log(`tuig ${VERSION}`);
  } else if (action.kind === "update") {
    await updateTuig(VERSION);
  } else {
    const saved = action.clean
      ? { repositories: [] }
      : await loadSessionPreferences();
    const requested = await createGitRepository(action.path);
    const savedPaths = saved.activeRepository
      ? [
          saved.activeRepository,
          ...saved.repositories.filter(
            (path) => path !== saved.activeRepository,
          ),
        ]
      : saved.repositories;
    const paths = action.pathProvided
      ? [requested.root, ...savedPaths]
      : savedPaths.length
        ? [...savedPaths, requested.root]
        : [requested.root];
    const repositories = [];
    for (const path of [...new Set(paths)]) {
      if (path === requested.root) {
        repositories.push(requested);
        continue;
      }
      try {
        repositories.push(await createGitRepository(path));
      } catch {
        // Missing or moved repositories are dropped when the session is saved.
      }
    }
    await runTuig(repositories);
  }
} catch (error) {
  if (error instanceof NotGitRepositoryError) {
    const [problem, ...guidance] = error.message.split("\n");
    console.error(`tuig: ${problem}`);
    if (guidance.length) console.log(guidance.join("\n"));
  } else {
    console.error(
      `tuig: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
}
