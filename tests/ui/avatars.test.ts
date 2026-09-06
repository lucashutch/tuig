import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGravatarUrl } from "../../src/ui/avatars.js";
import {
  cancelAvatarWork,
  getGitHubCommitAvatar,
  getGitHubCommitUrl,
  loadCachedAvatar,
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
    const writtenAt = (await stat(path)).mtimeMs;
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/author.git",
        "author-miss-sha",
        email,
      ),
    ).toBeUndefined();
    expect(fetches()).toBe(0);
    expect((await stat(path)).mtimeMs).toBe(writtenAt);

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

test("concurrent commits by one uncached author share one lookup", async () => {
  await withIsolatedCache(async ({ directory }) => {
    let calls = 0;
    const avatarUrl = "https://avatars.githubusercontent.com/u/987?v=4";
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ author: { avatar_url: avatarUrl } });
    }) as unknown as typeof fetch;
    const remote = "git@github.com:cached/concurrent.git";
    const shas = Array.from({ length: 12 }, (_, i) => `shared-${i}`);
    const results = await Promise.all(
      shas.map((sha) =>
        getGitHubCommitAvatar(remote, sha, "concurrent-hit@example.com"),
      ),
    );
    expect(calls).toBe(1);
    expect(results).toEqual(shas.map(() => avatarUrl));
    for (const sha of shas) {
      const key = createHash("sha256")
        .update(getGitHubCommitUrl(remote, sha)!)
        .digest("hex");
      expect(
        (await readFile(join(directory, `${key}.url`), "utf8")).trim(),
      ).toBe(avatarUrl);
    }
  });
});

test("aborting one author-lookup caller does not cancel another", async () => {
  await withIsolatedCache(async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    let sharedSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input, options) => {
      calls++;
      sharedSignal = options?.signal;
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const first = getGitHubCommitAvatar(
      "git@github.com:cached/shared.git",
      "abort-one",
      "shared-abort@example.com",
      controller.signal,
    );
    const second = getGitHubCommitAvatar(
      "git@github.com:cached/shared.git",
      "keep-two",
      "shared-abort@example.com",
    );
    await ready;
    controller.abort(new Error("row scrolled away"));
    await expect(first).rejects.toThrow("row scrolled away");
    expect(sharedSignal?.aborted).toBe(false);
    release(
      Response.json({
        author: { avatar_url: "https://avatars.githubusercontent.com/u/654" },
      }),
    );
    expect(await second).toContain("/654");
    expect(calls).toBe(1);
  });
});

test("a shared transport failure is retried rather than cached for the author", async () => {
  await withIsolatedCache(async ({ fetches }) => {
    const remote = "git@github.com:cached/shared-failure.git";
    await Promise.all(
      ["one", "two"].map((sha) =>
        getGitHubCommitAvatar(remote, sha, "shared-failure@example.com"),
      ),
    );
    expect(fetches()).toBe(1);
    await getGitHubCommitAvatar(remote, "retry", "shared-failure@example.com");
    expect(fetches()).toBe(2);
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
    expect(
      await getGitHubCommitAvatar(
        "git@github.com:cached/author.git",
        "offline-sha-retry",
        email,
      ),
    ).toBeUndefined();
    expect(fetches()).toBe(2);
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

test("shares an in-flight author lookup when one caller aborts", async () => {
  await withIsolatedCache(async () => {
    const email = "shared-author@example.com";
    const avatarUrl = "https://avatars.githubusercontent.com/u/987?v=4";
    let attempts = 0;
    let transportAborted = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const response = new Promise<Response>((resolve) => {
      release = () =>
        resolve(
          new Response(JSON.stringify({ author: { avatar_url: avatarUrl } }), {
            status: 200,
          }),
        );
    });
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
      attempts++;
      init?.signal?.addEventListener("abort", () => {
        transportAborted = true;
      });
      markStarted();
      return response;
    }) as unknown as typeof fetch;

    const firstAbort = new AbortController();
    const first = getGitHubCommitAvatar(
      "git@github.com:shared/avatar.git",
      "shared-first-sha",
      email,
      firstAbort.signal,
    );
    await started;
    const second = getGitHubCommitAvatar(
      "git@github.com:shared/avatar.git",
      "shared-second-sha",
      email,
    );
    firstAbort.abort();
    release();

    await expect(first).rejects.toThrow();
    await expect(second).resolves.toBe(avatarUrl);
    expect(attempts).toBe(1);
    expect(transportAborted).toBe(false);
  });
});

test("shutdown cancels an avatar request instead of waiting for its timeout", async () => {
  await withIsolatedCache(async () => {
    let aborted = false;
    let attempts = 0;
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        attempts++;
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    const load = loadCachedAvatar("https://example.com/never-answers.png");
    // Let the request reach fetch before the interface exits.
    await Bun.sleep(5);
    cancelAvatarWork();
    await expect(load).rejects.toThrow();
    expect(aborted).toBe(true);

    // Shutdown cancellation must not turn a transient abort into a remembered
    // source failure. A later caller gets a fresh request.
    const retry = loadCachedAvatar("https://example.com/never-answers.png");
    await Bun.sleep(5);
    expect(attempts).toBe(2);
    cancelAvatarWork();
    await expect(retry).rejects.toThrow();
  });
});
