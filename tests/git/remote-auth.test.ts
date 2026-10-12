import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitAuthError,
  GitRepositoryService,
  runGit,
} from "../../src/git/repository.js";

const cleanup: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});

test("fetch from an HTTPS remote that demands credentials reports a credential error and pauses auto fetch", async () => {
  // A real 401 makes Git ask for a username. Prompts are disabled, so Git
  // fails with "terminal prompts disabled", the case users hit in Tuig.
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("denied", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="git"' },
      }),
  });
  servers.push(server);
  const root = await mkdtemp(join(tmpdir(), "tuig-auth-"));
  cleanup.push(root);
  await runGit(["init", "-b", "main"], root);
  await runGit(
    ["remote", "add", "origin", `http://127.0.0.1:${server.port}/x.git`],
    root,
  );
  const repo = await GitRepositoryService.open(root);

  expect(repo.authBlocked).toBe(false);
  const error = await repo.fetch().catch((e) => e);
  expect(error).toBeInstanceOf(GitAuthError);
  expect(error.message).toBe(
    "Fetch needs credentials for 127.0.0.1. Set up a credential helper or an SSH key in an agent.",
  );
  expect(repo.authBlocked).toBe(true);
}, 20_000);
