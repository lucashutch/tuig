#!/usr/bin/env bun
import {
  createGitRepository,
  createPullRequestService,
  NotGitRepositoryError,
} from "./git/index.js";
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
      ? { repositories: [] as string[] }
      : await loadSessionPreferences();
    // An explicit path must be a repository. Without one, restore the saved
    // tabs and only fall back to the current directory when none remain.
    const requested = action.pathProvided
      ? await createGitRepository(action.path)
      : undefined;
    const repositories = [];
    for (const path of new Set(saved.repositories)) {
      if (path === requested?.root) continue;
      try {
        repositories.push(await createGitRepository(path));
      } catch {
        // Missing or moved repositories are dropped when the session is saved.
      }
    }
    if (requested) repositories.push(requested);
    if (repositories.length === 0)
      repositories.push(await createGitRepository(action.path));
    await runTuig(
      repositories,
      requested?.root ?? saved.activeRepository,
      action.clean ? undefined : saved.submodules,
      { pullRequests: (root) => createPullRequestService(root) },
      saved.recentRepositories ?? [],
    );
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
