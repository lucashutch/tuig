import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGravatarUrl } from "../../src/ui/avatars.js";
import {
  getGitHubCommitAvatar,
  getGitHubCommitUrl,
} from "../../src/ui/avatars.js";

describe("Gravatar URLs", () => {
  test("returns undefined for blank or invalid email addresses", () => {
    expect(getGravatarUrl("  ")).toBeUndefined();
    expect(getGravatarUrl("not-an-email")).toBeUndefined();
  });

  test("normalizes the email before hashing", () => {
    expect(getGravatarUrl("  Ada@Example.com ")).toBe(
      "https://www.gravatar.com/avatar/b5fc85e55755f9e0d030a10ab4429b6b2944855f9a0d60077fe832becbc41d72?s=64&d=404",
    );
  });

  test("uses a stable HTTPS URL with a missing-image fallback", () => {
    const url = getGravatarUrl("ada@example.com");
    expect(url).toStartWith("https://www.gravatar.com/avatar/");
    expect(url).toEndWith("?s=64&d=404");
  });
});

test("GitHub commit URLs use a GitHub origin and commit SHA", () => {
  expect(getGitHubCommitUrl("git@github.com:acme/project.git", "abc123")).toBe(
    "https://api.github.com/repos/acme/project/commits/abc123",
  );
  expect(
    getGitHubCommitUrl("https://github.com/acme/project.git/", "abc123"),
  ).toBe("https://api.github.com/repos/acme/project/commits/abc123");
  expect(
    getGitHubCommitUrl("https://example.com/acme/project.git", "abc123"),
  ).toBeUndefined();
  expect(
    getGitHubCommitUrl("https://notgithub.com/acme/project.git", "abc123"),
  ).toBeUndefined();
});

test("GitHub avatar URLs survive a process restart through the disk cache", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "tuig-avatar-cache-"));
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  const apiUrl = getGitHubCommitUrl(
    "git@github.com:cached/avatar.git",
    "disk-cache-test",
  )!;
  const avatarUrl = "https://avatars.githubusercontent.com/u/123?v=4";
  const key = createHash("sha256").update(apiUrl).digest("hex");
  process.env.XDG_CACHE_HOME = cacheHome;

  try {
    const directory = join(cacheHome, "tuig", "avatars");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${key}.url`), `${avatarUrl}\n`);
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/avatar.git",
        "disk-cache-test",
      ),
    ).toBe(avatarUrl);
  } finally {
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCacheHome;
    await rm(cacheHome, { recursive: true, force: true });
  }
});

test("a remembered miss keeps repeat scrolls off the GitHub API", async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), "tuig-avatar-miss-"));
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  const remote = "git@github.com:cached/miss.git";
  const apiUrl = getGitHubCommitUrl(remote, "miss-cache-test")!;
  const key = createHash("sha256").update(apiUrl).digest("hex");
  process.env.XDG_CACHE_HOME = cacheHome;

  try {
    const directory = join(cacheHome, "tuig", "avatars");
    await mkdir(directory, { recursive: true });
    // GitHub allows 60 unauthenticated requests an hour, so a commit with no
    // linked account must not be looked up again on the next scroll.
    await writeFile(join(directory, `${key}.url`), "none\n");
    expect(
      await getGitHubCommitAvatar(
        remote,
        "miss-cache-test",
        "miss@example.com",
      ),
    ).toBeUndefined();
  } finally {
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCacheHome;
    await rm(cacheHome, { recursive: true, force: true });
  }
});

/** Run `body` with an isolated cache directory and no reachable GitHub. */
async function withIsolatedCache(
  body: (context: {
    directory: string;
    fetches: () => number;
  }) => Promise<void>,
) {
  const cacheHome = await mkdtemp(join(tmpdir(), "tuig-avatar-author-"));
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  const previousPath = process.env.PATH;
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  process.env.XDG_CACHE_HOME = cacheHome;
  // An empty PATH keeps `gh` from resolving, so the public API is the only
  // lookup a test can observe.
  process.env.PATH = join(cacheHome, "empty-bin");
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("network disabled in tests");
  }) as unknown as typeof fetch;
  const directory = join(cacheHome, "tuig", "avatars");
  await mkdir(directory, { recursive: true });
  try {
    await body({ directory, fetches: () => fetches });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCacheHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(cacheHome, { recursive: true, force: true });
  }
}

function authorCacheKey(host: string, email: string): string {
  return createHash("sha256").update(`author:${host}:${email}`).digest("hex");
}

test("a persisted author avatar skips the lookup for an unseen commit", async () => {
  await withIsolatedCache(async ({ directory, fetches }) => {
    const email = "persisted-hit@example.com";
    const avatarUrl = "https://avatars.githubusercontent.com/u/456?v=4";
    await writeFile(
      join(directory, `${authorCacheKey("github.com", email)}.url`),
      `${avatarUrl}\n`,
    );
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/author.git",
        "author-hit-sha",
        email,
      ),
    ).toBe(avatarUrl);
    expect(fetches()).toBe(0);
  });
});

test("a persisted author miss is retried only after the miss TTL", async () => {
  await withIsolatedCache(async ({ directory, fetches }) => {
    const email = "persisted-miss@example.com";
    const path = join(directory, `${authorCacheKey("github.com", email)}.url`);
    await writeFile(path, "none\n");
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/author.git",
        "author-miss-sha",
        email,
      ),
    ).toBeUndefined();
    expect(fetches()).toBe(0);

    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(path, expired, expired);
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/author.git",
        "author-miss-sha-2",
        email,
      ),
    ).toBeUndefined();
    expect(fetches()).toBe(1);
  });
});

test("an expired author avatar is refreshed", async () => {
  await withIsolatedCache(async ({ directory, fetches }) => {
    const email = "persisted-stale@example.com";
    const path = join(directory, `${authorCacheKey("github.com", email)}.url`);
    await writeFile(path, "https://avatars.githubusercontent.com/u/789?v=4\n");
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(path, expired, expired);
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/author.git",
        "author-stale-sha",
        email,
      ),
    ).toBeUndefined();
    expect(fetches()).toBe(1);
    // The refresh failed rather than establishing an absence, so the known URL
    // survives for the next attempt instead of being downgraded to a miss.
    expect((await readFile(path, "utf8")).trim()).toBe(
      "https://avatars.githubusercontent.com/u/789?v=4",
    );
  });
});

test("a failed lookup is not remembered as an author-wide miss", async () => {
  await withIsolatedCache(async ({ directory, fetches }) => {
    const email = "offline@example.com";
    const path = join(directory, `${authorCacheKey("github.com", email)}.url`);
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/author.git",
        "offline-sha",
        email,
      ),
    ).toBeUndefined();
    expect(fetches()).toBe(1);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

test("a commit with no linked account is remembered as a miss", async () => {
  await withIsolatedCache(async ({ directory }) => {
    const email = "unlinked@example.com";
    const path = join(directory, `${authorCacheKey("github.com", email)}.url`);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ author: null }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/author.git",
        "unlinked-sha",
        email,
      ),
    ).toBeUndefined();
    expect((await readFile(path, "utf8")).trim()).toBe("none");
  });
});
