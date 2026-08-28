import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NativeImage } from "@opentui/core";
import { debugLog } from "./debug-log.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AVATAR_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
/** Known misses expire sooner: an author may gain an avatar any day. */
const AVATAR_MISS_TTL = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 5000;
const DECODED_AVATAR_CACHE_SIZE = 128;
const CIRCULAR_CACHE_SIZE = 256;
/** Concurrent GitHub lookups. A tall viewport would otherwise spawn one `gh` per row. */
const GITHUB_LOOKUP_CONCURRENCY = 4;
const githubAvatarCache = new Map<string, string>();
const authorAvatarCache = new Map<string, string>();
const decodedAvatarCache = new Map<string, NativeImage>();
const pendingAvatarLoads = new Map<string, Promise<NativeImage>>();
/** Sources that failed to load, with the time of the failure. */
const failedAvatarSources = new Map<string, number>();

/** Drop least-recently-used entries until the map fits, disposing the images. */
function evictImages(cache: Map<string, NativeImage>, limit: number) {
  while (cache.size > limit) {
    const oldest = cache.entries().next().value as
      | [string, NativeImage]
      | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    oldest[1].dispose();
  }
}

/** Combine a caller's abort signal with a request deadline. */
function requestSignal(
  signal?: AbortSignal,
  ms = REQUEST_TIMEOUT,
): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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

// A graph avatar covers roughly three cells, so 48px stays sharp on terminals
// with wide cells without paying for pixels no protocol will show.
const AVATAR_SIZE = 48;
/** Canvas width as a multiple of the circle diameter, for a "fill" 3x1 box. */
const AVATAR_PAD_RATIO = 1.5;
const circularCache = new Map<string, NativeImage>();

function ringRgb(color: string): [number, number, number] | undefined {
  const hex = color.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

export interface CircularAvatarOptions {
  /** Lane color for the outline ring and the lane stripe. */
  ringColor: string;
  /** Row background painted behind the circle. */
  background: string;
  /** Identity of the finished canvas, including colors and lane continuation. */
  cacheKey: string;
  continuesAbove?: boolean;
  continuesBelow?: boolean;
  /** Canvas width as a multiple of the diameter. One yields a square. */
  padRatio?: number;
}

/**
 * Mask an avatar into a circle with an outline in the lane color.
 *
 * The canvas is wider than the circle so a 3x1 cell image box can center the
 * circle on its middle cell without stretching. Corners are painted with the
 * row background instead of left transparent: terminal image protocols are
 * inconsistent about alpha, and an opaque corner matching the row reads as
 * blended either way. The ring sits inside the circle edge, because an
 * outline drawn outside would be cut off by the image bounds. The lane stripe
 * continues above and below the circle so the graph line is not covered.
 *
 * The caller owns the returned image and should dispose it.
 */
export function circularAvatar(
  image: NativeImage,
  options: CircularAvatarOptions,
): NativeImage {
  const {
    ringColor,
    background,
    cacheKey,
    continuesAbove = true,
    continuesBelow = true,
    padRatio = AVATAR_PAD_RATIO,
  } = options;
  const cached = circularCache.get(cacheKey);
  if (cached) {
    // Refresh insertion order so avatars on screen survive eviction.
    circularCache.delete(cacheKey);
    circularCache.set(cacheKey, cached);
    return cached.clone();
  }
  const size = AVATAR_SIZE;
  const width = Math.max(size, Math.round(size * padRatio));
  const left = Math.floor((width - size) / 2);
  const resized = image.resize({ width: size, height: size });
  const raw = resized.raw("rgba8");
  const stride = raw.stride || size * 4;
  const pixels = new Uint8Array(width * size * 4);
  const ring = ringRgb(ringColor) ?? [136, 136, 136];
  const corner = ringRgb(background) ?? [0, 0, 0];
  const centerX = (width - 1) / 2;
  const centerY = (size - 1) / 2;
  const outer = size / 2 - 1;
  const ringThickness = Math.max(3, Math.round(size * 0.075));
  // Build the padded canvas in one pass; a second copy to widen it would
  // double the per-pixel work for an image only a few cells wide.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot((x - centerX) / outer, (y - centerY) / outer);
      const out = (y * width + x) * 4;
      if (distance >= 1) {
        const lane =
          Math.abs(x - centerX) <= ringThickness / 2 &&
          (y < centerY ? continuesAbove : continuesBelow);
        pixels[out] = lane ? ring[0] : corner[0];
        pixels[out + 1] = lane ? ring[1] : corner[1];
        pixels[out + 2] = lane ? ring[2] : corner[2];
        pixels[out + 3] = 255;
        continue;
      }
      if (distance >= 1 - ringThickness / outer) {
        pixels[out] = ring[0];
        pixels[out + 1] = ring[1];
        pixels[out + 2] = ring[2];
        // Keep the canvas opaque. Some terminal image protocols composite
        // translucent edge pixels against black instead of the row color.
        const edge = Math.min(1, Math.max(0, (1 - distance) * outer));
        pixels[out] = Math.round(corner[0] + (ring[0] - corner[0]) * edge);
        pixels[out + 1] = Math.round(corner[1] + (ring[1] - corner[1]) * edge);
        pixels[out + 2] = Math.round(corner[2] + (ring[2] - corner[2]) * edge);
        pixels[out + 3] = 255;
        continue;
      }
      const source = y * stride + (x - left) * 4;
      pixels[out] = raw.data[source]!;
      pixels[out + 1] = raw.data[source + 1]!;
      pixels[out + 2] = raw.data[source + 2]!;
      pixels[out + 3] = raw.data[source + 3]!;
    }
  }
  resized.dispose();
  const masked = NativeImage.fromRgba(pixels, width, size);
  circularCache.set(cacheKey, masked);
  evictImages(circularCache, CIRCULAR_CACHE_SIZE);
  return masked.clone();
}

/** Build an immediate deterministic fallback while a remote avatar loads. */
export function fallbackAvatar(
  identity: string,
  options: Omit<CircularAvatarOptions, "cacheKey">,
): NativeImage {
  const digest = createHash("sha256")
    .update(identity.trim().toLowerCase())
    .digest();
  const pixels = new Uint8Array(AVATAR_SIZE * AVATAR_SIZE * 4);
  const base: [number, number, number] = [
    72 + (digest[0]! % 112),
    72 + (digest[1]! % 112),
    72 + (digest[2]! % 112),
  ];
  const accent: [number, number, number] = base.map((channel) =>
    Math.min(224, channel + 36),
  ) as [number, number, number];
  for (let y = 0; y < AVATAR_SIZE; y++) {
    for (let x = 0; x < AVATAR_SIZE; x++) {
      const mirrored = x < AVATAR_SIZE / 2 ? x : AVATAR_SIZE - 1 - x;
      const bit = digest[(mirrored >> 3) + (y >> 3) * 3]! >> (mirrored & 7);
      const color = bit & 1 ? accent : base;
      const out = (y * AVATAR_SIZE + x) * 4;
      pixels[out] = color[0];
      pixels[out + 1] = color[1];
      pixels[out + 2] = color[2];
      pixels[out + 3] = 255;
    }
  }
  const source = NativeImage.fromRgba(pixels, AVATAR_SIZE, AVATAR_SIZE);
  const result = circularAvatar(source, {
    ...options,
    cacheKey: `fallback:${identity.trim().toLowerCase()}|${options.ringColor}|${options.background}|${Number(options.continuesAbove ?? true)}${Number(options.continuesBelow ?? true)}`,
  });
  source.dispose();
  return result;
}

/** Path of a cached avatar artifact. `kind` separates images from metadata. */
function avatarCachePath(source: string, kind: "img" | "url"): string {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const key = createHash("sha256").update(source).digest("hex");
  return join(cacheHome, "tuig", "avatars", `${key}.${kind}`);
}

const MISS_MARKER = "none";

type CachedSource = { kind: "hit"; url: string } | { kind: "miss" } | undefined;

async function readCachedAvatarSource(source: string): Promise<CachedSource> {
  const path = avatarCachePath(source, "url");
  try {
    const age = Date.now() - (await stat(path)).mtimeMs;
    const value = (await readFile(path, "utf8")).trim();
    if (value === MISS_MARKER)
      return age < AVATAR_MISS_TTL ? { kind: "miss" } : undefined;
    if (age >= AVATAR_CACHE_TTL) return undefined;
    return /^https:\/\//.test(value) ? { kind: "hit", url: value } : undefined;
  } catch {
    return undefined;
  }
}

async function writeCachedAvatarSource(source: string, value: string) {
  const path = avatarCachePath(source, "url");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, `${value}\n`);
  await rename(temporary, path);
}

/** Load an avatar from the seven-day disk cache, refreshing it when stale. */
export async function loadCachedAvatar(
  source: string,
  signal?: AbortSignal,
): Promise<NativeImage> {
  const cached = decodedAvatarCache.get(source);
  if (cached) {
    // Refresh insertion order so frequently visible authors stay resident.
    decodedAvatarCache.delete(source);
    decodedAvatarCache.set(source, cached);
    return cached.clone();
  }
  const failedAt = failedAvatarSources.get(source);
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < AVATAR_MISS_TTL)
      throw new Error("avatar is known to be unavailable");
    failedAvatarSources.delete(source);
  }
  // Share the underlying load even when this caller can be aborted. Scrolling
  // should stop a row from claiming the result, not start another download of
  // the same author for every commit that enters the viewport.
  let load = pendingAvatarLoads.get(source);
  if (!load) {
    load = loadAvatarFromDiskOrNetwork(source).then((image) => {
      cacheDecodedAvatar(source, image);
      return image;
    });
    pendingAvatarLoads.set(source, load);
    void load.then(
      () => pendingAvatarLoads.delete(source),
      () => pendingAvatarLoads.delete(source),
    );
  }
  try {
    return (await abortable(load, signal)).clone();
  } catch (error) {
    if (!signal?.aborted) failedAvatarSources.set(source, Date.now());
    throw error;
  }
}

function cacheDecodedAvatar(source: string, image: NativeImage) {
  const previous = decodedAvatarCache.get(source);
  if (previous && previous !== image) previous.dispose();
  decodedAvatarCache.delete(source);
  decodedAvatarCache.set(source, image);
  evictImages(decodedAvatarCache, DECODED_AVATAR_CACHE_SIZE);
}

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

async function loadAvatarFromDiskOrNetwork(
  source: string,
  signal?: AbortSignal,
): Promise<NativeImage> {
  const path = avatarCachePath(source, "img");
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
      signal: requestSignal(signal),
    });
    if (!response.ok)
      throw new Error(`avatar request failed: ${response.status}`);
    // Reject oversized avatars from the header rather than after buffering
    // the whole body.
    const header = response.headers.get("content-length");
    const declared = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
      await response.body?.cancel();
      throw new Error("avatar is too large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_AVATAR_BYTES)
      throw new Error("avatar is too large");
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await Bun.write(temporary, bytes);
    await rename(temporary, path);
    return NativeImage.decode(bytes);
  } catch (error) {
    debugLog("avatar", `fetch failed for ${source}`, error);
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
  // A remembered miss matters more than a hit: GitHub allows 60 unauthenticated
  // requests an hour, and a repo of commits without linked accounts would burn
  // that on every scroll.
  if (diskCached?.kind === "miss") return undefined;
  if (diskCached?.kind === "hit") {
    githubAvatarCache.set(url, diskCached.url);
    if (authorKey) authorAvatarCache.set(authorKey, diskCached.url);
    return diskCached.url;
  }
  const result = await withGitHubSlot(
    () => resolveGitHubCommitAvatar(url, signal),
    signal,
  );
  if (result.url) {
    githubAvatarCache.set(url, result.url);
    if (authorKey) authorAvatarCache.set(authorKey, result.url);
  }
  if (result.url || result.confirmedAbsent)
    await writeCachedAvatarSource(url, result.url ?? MISS_MARKER).catch(
      () => undefined,
    );
  return result.url;
}

/** Resolve with the shared lookup, or reject as soon as this caller aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

let activeGitHubLookups = 0;
const gitHubLookupQueue: Array<() => void> = [];

async function withGitHubSlot<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (activeGitHubLookups >= GITHUB_LOOKUP_CONCURRENCY) {
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
      gitHubLookupQueue.push(resolve);
    });
    try {
      await abortable(waiting, signal);
    } catch (error) {
      const index = gitHubLookupQueue.indexOf(resume);
      if (index >= 0) gitHubLookupQueue.splice(index, 1);
      throw error;
    }
    if (signal?.aborted) {
      gitHubLookupQueue.shift()?.();
      signal.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  activeGitHubLookups++;
  try {
    return await run();
  } finally {
    activeGitHubLookups--;
    gitHubLookupQueue.shift()?.();
  }
}

type GitHubAvatarLookup = { url?: string; confirmedAbsent: boolean };

async function resolveGitHubCommitAvatar(
  url: string,
  signal?: AbortSignal,
): Promise<GitHubAvatarLookup> {
  const fromCli = await resolveWithGitHubCli(url, signal);
  if (fromCli) return { url: fromCli, confirmedAbsent: false };
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tuig",
      },
      signal: requestSignal(signal),
    });
    if (!response.ok) {
      debugLog("avatar", `github api ${response.status} for ${url}`);
      return { confirmedAbsent: false };
    }
    const data = (await response.json()) as {
      author?: { avatar_url?: string } | null;
    };
    const avatar = data.author?.avatar_url;
    return avatar
      ? { url: avatar, confirmedAbsent: false }
      : { confirmedAbsent: true };
  } catch (error) {
    debugLog("avatar", `github api failed for ${url}`, error);
    return { confirmedAbsent: false };
  }
}

/** Ask `gh` first so authenticated users get a higher rate limit. */
async function resolveWithGitHubCli(url: string, signal?: AbortSignal) {
  let apiPath: string;
  try {
    apiPath = new URL(url).pathname.slice(1);
  } catch {
    return undefined;
  }
  let child: ReturnType<typeof spawnGitHubCli>;
  try {
    child = spawnGitHubCli(apiPath);
  } catch (error) {
    // No `gh` on PATH is the common case; the public API is the fallback.
    debugLog("avatar", "gh is unavailable", error);
    return undefined;
  }
  // `gh` can block indefinitely on a credential helper or a stalled network,
  // and an unbounded wait leaves the avatar slot empty with no diagnostic.
  const timer = setTimeout(() => child.kill(), REQUEST_TIMEOUT);
  const onAbort = () => child.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (exitCode === 0 && stdout.trim()) return stdout.trim();
    debugLog("avatar", `gh api exited ${exitCode} for ${apiPath}`);
    return undefined;
  } catch (error) {
    debugLog("avatar", `gh api failed for ${apiPath}`, error);
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function spawnGitHubCli(apiPath: string) {
  return Bun.spawn(
    ["gh", "api", apiPath, "--jq", ".author.avatar_url // empty"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
}
