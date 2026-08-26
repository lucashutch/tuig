import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NativeImage } from "@opentui/core";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AVATAR_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const githubAvatarCache = new Map<string, string>();
const authorAvatarCache = new Map<string, string>();

/** Use public provider avatars for recognizable automated co-authors. */
export function getProviderAvatarUrl(
  name: string,
  email: string,
): string | undefined {
  const value = `${name} ${email}`.toLowerCase();
  if (/(?:^|[.@])anthropic\.com\b|\bclaude\b/.test(value))
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Claude-ai-icon.svg/120px-Claude-ai-icon.svg.png";
  if (/(?:^|[.@])openai\.com\b|\b(?:openai|chatgpt)\b/.test(value))
    return "https://github.com/openai.png?size=64";
  return undefined;
}

/** Return the Gravatar image URL for an author email address. */
export function getGravatarUrl(email: string): string | undefined {
  const normalized = email.trim().toLowerCase();
  if (!emailPattern.test(normalized)) return undefined;

  const hash = createHash("sha256").update(normalized).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?s=64&d=404`;
}

function avatarCachePath(source: string): string {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const key = createHash("sha256").update(source).digest("hex");
  return join(cacheHome, "tuig", "avatars", `${key}.img`);
}

function avatarSourceCachePath(source: string): string {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const key = createHash("sha256").update(source).digest("hex");
  return join(cacheHome, "tuig", "avatars", `${key}.url`);
}

async function readCachedAvatarSource(
  source: string,
): Promise<string | undefined> {
  const path = avatarSourceCachePath(source);
  try {
    if (Date.now() - (await stat(path)).mtimeMs >= AVATAR_CACHE_TTL)
      return undefined;
    const value = (await readFile(path, "utf8")).trim();
    return /^https:\/\//.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeCachedAvatarSource(source: string, value: string) {
  const path = avatarSourceCachePath(source);
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, `${value}\n`);
  await rename(temporary, path);
}

/** Load an avatar from the seven-day disk cache, refreshing it when stale. */
export async function loadCachedAvatar(
  source: string,
  signal?: AbortSignal,
): Promise<NativeImage> {
  const path = avatarCachePath(source);
  let stale: boolean;
  try {
    stale = Date.now() - (await stat(path)).mtimeMs >= AVATAR_CACHE_TTL;
    if (!stale) return await NativeImage.load(path, { signal });
  } catch {
    stale = true;
  }
  try {
    const response = await fetch(source, {
      headers: { "User-Agent": "tuig" },
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`avatar request failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024)
      throw new Error("avatar is too large");
    await mkdir(join(path, ".."), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await Bun.write(temporary, bytes);
    await rename(temporary, path);
    return NativeImage.decode(bytes);
  } catch (error) {
    if (!stale) throw error;
    // A stale image is still useful when the network is unavailable.
    return NativeImage.load(path, { signal });
  }
}

/** Return GitHub's commit API URL when the origin identifies a GitHub repo. */
export function getGitHubCommitUrl(
  remote: string | undefined,
  sha: string,
): string | undefined {
  if (!remote || !sha) return undefined;
  const value = remote.trim();
  let owner: string | undefined;
  let repository: string | undefined;
  const scp = value.match(
    /^[^@/:]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (scp) {
    owner = scp[1];
    repository = scp[2];
  } else {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) return undefined;
      owner = parts[0];
      repository = parts[1]?.replace(/\.git$/, "");
    } catch {
      return undefined;
    }
  }
  if (!owner || !repository) return undefined;
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(sha)}`;
}

/** Resolve the avatar URL GitHub associates with a commit. */
export async function getGitHubCommitAvatar(
  remote: string | undefined,
  sha: string,
  email = "",
  signal?: AbortSignal,
): Promise<string | undefined> {
  const url = getGitHubCommitUrl(remote, sha);
  if (!url) return undefined;
  const authorKey = email.trim().toLowerCase();
  const cachedAuthor = authorAvatarCache.get(authorKey);
  if (authorKey && cachedAuthor) return cachedAuthor;
  const cached = githubAvatarCache.get(url);
  if (cached) {
    if (authorKey) authorAvatarCache.set(authorKey, cached);
    return cached;
  }
  const diskCached = await readCachedAvatarSource(url);
  if (diskCached) {
    githubAvatarCache.set(url, diskCached);
    if (authorKey) authorAvatarCache.set(authorKey, diskCached);
    return diskCached;
  }
  const result = await resolveGitHubCommitAvatar(url, signal);
  if (result) {
    githubAvatarCache.set(url, result);
    if (authorKey) authorAvatarCache.set(authorKey, result);
    await writeCachedAvatarSource(url, result).catch(() => undefined);
  }
  return result;
}

async function resolveGitHubCommitAvatar(url: string, signal?: AbortSignal) {
  try {
    const apiPath = new URL(url).pathname.slice(1);
    const process = Bun.spawn(
      ["gh", "api", apiPath, "--jq", ".author.avatar_url // empty"],
      { stdout: "pipe", stderr: "ignore" },
    );
    signal?.addEventListener("abort", () => process.kill(), { once: true });
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);
    if (exitCode === 0 && stdout.trim()) return stdout.trim();
  } catch {
    // Fall through to the unauthenticated public API.
  }
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tuig",
      },
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      author?: { avatar_url?: string } | null;
    };
    return data.author?.avatar_url;
  } catch {
    return undefined;
  }
}
