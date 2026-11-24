//! Author avatars: where an avatar comes from, the cache, and the circular graph image. Ports `src/ui/avatars.ts`.
//! The provider badge for automated co-authors (`getProviderAvatarUrl`) is [`provider_avatar_url`]. The commit
//! details pane draws it beside the co-author line, and loads it with [`AvatarService::load_image`], so it shares
//! the memory and disk caches and the failure memory of every other avatar.
//!
//! Nothing here touches the UI. [`AvatarService::load`] returns decoded pixels, and [`circular_avatar`] masks them
//! into the three-cell canvas that sits over a graph dot. The shell turns the canvas into an OpenTUI image.
//!
//! The network sits behind [`AvatarFetcher`]. [`SystemFetcher`] runs `curl` and `gh`. Tests use a fake.
//!
//! Layers, from fastest: decoded pixels in memory, avatar URLs in memory, then files under
//! `$XDG_CACHE_HOME/tuig/avatars` (the same files the TypeScript app writes). An image file stays fresh for seven
//! days. A remembered miss, the `none` marker in a URL file, lasts one day.

use async_trait::async_trait;
use regex::Regex;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, SystemTime};
use tokio::process::Command;
use tokio::sync::{OnceCell, Semaphore};
use tuig_git::debug_log::{debug_log, debug_log_error};
use tuig_git::pull_requests::{GhRunOptions, run_program};
use tuig_ui_model::bounded_cache::BoundedCache;
use tuig_ui_model::color::Rgba;

/// Side of a decoded avatar. A graph avatar covers about three cells, so 48 pixels stay sharp on terminals with
/// wide cells. `AVATAR_SIZE`.
pub const AVATAR_SIZE: u32 = 48;
/// Canvas width as a multiple of the circle diameter. The canvas is wider than the circle so a three by one cell
/// image box centres the circle on its middle cell without stretching it.
const AVATAR_PAD_RATIO: f64 = 1.5;
const AVATAR_CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Known misses expire sooner: an author may gain an avatar any day.
const AVATAR_MISS_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const METADATA_CACHE_SIZE: usize = 512;
const DECODED_CACHE_SIZE: usize = 128;
/// Concurrent GitHub lookups. A tall viewport would otherwise start one `gh` per row.
const GITHUB_LOOKUP_CONCURRENCY: usize = 4;
const MAX_AVATAR_BYTES: u64 = 8 * 1024 * 1024;
const MISS_MARKER: &str = "none";

/// Straight-alpha RGBA8 pixels without row padding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// The pixel format a terminal image protocol shows. `Blocks` is half-block text, which is too coarse here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelProtocol {
    Kitty,
    Sixel,
    Blocks,
}

/// Rejects image protocols that are known to be unusable from this process.
///
/// OpenTUI's capability probe can report Kitty graphics through a WSL relay even though the Windows terminal cannot
/// show the placements. WSL passes only when the hosting terminal names itself as one with a native graphics
/// protocol. `terminalGraphicsSupported`.
pub fn terminal_graphics_supported(
    protocol: PixelProtocol,
    env: impl Fn(&str) -> Option<String>,
) -> bool {
    if protocol == PixelProtocol::Blocks {
        return false;
    }
    let set = |name: &str| env(name).is_some_and(|value| !value.is_empty());
    if !set("WSL_DISTRO_NAME") && !set("WSL_INTEROP") {
        return true;
    }
    set("KITTY_WINDOW_ID")
        || set("WEZTERM_PANE")
        || env("TERM_PROGRAM").is_some_and(|value| value.to_lowercase() == "wezterm")
        || env("TERM").is_some_and(|value| value.to_lowercase().contains("kitty"))
}

static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("valid regex"));
static SCP_GITHUB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[^@/:]+@github\.com:([^/]+)/([^/]+?)(?:\.git)?/?$").expect("valid regex")
});
static SCP_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^@/:]+@([^/:]+):").expect("valid regex"));

static ANTHROPIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[.@])anthropic\.com(?-u:\b)|(?-u:\b)claude(?-u:\b)").unwrap()
});
static OPENAI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|[.@])openai\.com(?-u:\b)|(?-u:\b)(?:openai|chatgpt)(?-u:\b)").unwrap()
});

const CLAUDE_AVATAR_URL: &str = "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Claude-ai-icon.svg/120px-Claude-ai-icon.svg.png";
const OPENAI_AVATAR_URL: &str = "https://github.com/openai.png?size=64";

/// The public avatar for a recognizable automated co-author: Claude for `anthropic.com` or "claude", OpenAI for
/// `openai.com`, "openai" or "chatgpt". The name and email are matched together, lowercased. The word boundary is
/// ASCII, as in JavaScript. `getProviderAvatarUrl`.
pub fn provider_avatar_url(name: &str, email: &str) -> Option<&'static str> {
    let value = format!("{name} {email}").to_lowercase();
    if ANTHROPIC.is_match(&value) {
        Some(CLAUDE_AVATAR_URL)
    } else if OPENAI.is_match(&value) {
        Some(OPENAI_AVATAR_URL)
    } else {
        None
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// The Gravatar image URL for an author email address. `getGravatarUrl`.
pub fn gravatar_url(email: &str) -> Option<String> {
    let normalized = email.trim().to_lowercase();
    EMAIL.is_match(&normalized).then(|| {
        format!(
            "https://www.gravatar.com/avatar/{}?s=64&d=404",
            sha256_hex(&normalized)
        )
    })
}

/// `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Host and path segments of a URL with a scheme, or `None` for anything else.
fn parse_url(value: &str) -> Option<(String, Vec<String>)> {
    let (scheme, rest) = value.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?.to_lowercase();
    let path = tail.split(['?', '#']).next().unwrap_or("");
    let parts = path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    Some((host, parts))
}

/// GitHub's commit API URL when the origin names a GitHub repository. `getGitHubCommitUrl`.
pub fn github_commit_url(remote: Option<&str>, sha: &str) -> Option<String> {
    let remote = remote.filter(|remote| !remote.is_empty())?;
    if sha.is_empty() {
        return None;
    }
    let value = remote.trim();
    let (owner, repository) = if let Some(found) = SCP_GITHUB.captures(value) {
        (found[1].to_string(), found[2].to_string())
    } else {
        let (host, parts) = parse_url(value)?;
        if host != "github.com" || parts.len() != 2 {
            return None;
        }
        let repository = parts[1].strip_suffix(".git").unwrap_or(&parts[1]);
        (parts[0].clone(), repository.to_string())
    };
    if owner.is_empty() || repository.is_empty() {
        return None;
    }
    Some(format!(
        "https://api.github.com/repos/{}/{}/commits/{}",
        encode_component(&owner),
        encode_component(&repository),
        encode_component(sha)
    ))
}

/// Host of a remote, so two forges cannot share an author cache entry.
fn remote_host(remote: &str) -> String {
    let value = remote.trim();
    if let Some(found) = SCP_HOST.captures(value) {
        return found[1].to_lowercase();
    }
    parse_url(value).map_or_else(|| value.to_lowercase(), |(host, _)| host)
}

/// Cache key for an author's avatar on one forge. Keyed on the author rather than the commit, so a new commit by a
/// known author costs no request: GitHub allows 60 unauthenticated lookups an hour.
fn author_cache_source(remote: &str, email: &str) -> String {
    format!("author:{}:{email}", remote_host(remote))
}

#[derive(Debug, Clone, Copy)]
pub struct CircleOptions {
    /// Lane color, for the outline ring and the lane stripe.
    pub ring: Rgba,
    /// Row background, painted behind the circle.
    pub background: Rgba,
    pub continues_above: bool,
    pub continues_below: bool,
}

/// `Math.round`: halves round up.
fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Masks a square avatar into a circle with an outline in the lane color. `circularAvatar`.
///
/// The canvas is wider than the circle. Its corners take the row background instead of staying transparent,
/// because terminal image protocols treat alpha differently, and an opaque corner that matches the row reads as
/// blended either way. The ring sits inside the circle edge, because an outline outside it would be cut off by the
/// image bounds. The lane stripe continues above and below the circle so the graph line stays visible.
///
/// # Panics
/// When `source` is not [`AVATAR_SIZE`] pixels square.
pub fn circular_avatar(source: &Pixels, options: &CircleOptions) -> Pixels {
    assert!(
        source.width == AVATAR_SIZE && source.height == AVATAR_SIZE,
        "an avatar is {AVATAR_SIZE} pixels square"
    );
    let size = AVATAR_SIZE as usize;
    let width = size.max(round(size as f64 * AVATAR_PAD_RATIO) as usize);
    let left = (width - size) / 2;
    let stride = size * 4;
    let mut pixels = vec![0u8; width * size * 4];
    let ring = [options.ring.r, options.ring.g, options.ring.b];
    let corner = [
        options.background.r,
        options.background.g,
        options.background.b,
    ];
    let center_x = (width as f64 - 1.0) / 2.0;
    let center_y = (size as f64 - 1.0) / 2.0;
    let outer = size as f64 / 2.0 - 1.0;
    let thickness = 3.0f64.max(round(size as f64 * 0.075));
    for y in 0..size {
        for x in 0..width {
            let distance = ((x as f64 - center_x) / outer).hypot((y as f64 - center_y) / outer);
            let out = (y * width + x) * 4;
            if distance >= 1.0 {
                let continues = if (y as f64) < center_y {
                    options.continues_above
                } else {
                    options.continues_below
                };
                let lane = (x as f64 - center_x).abs() <= thickness / 2.0 && continues;
                let color = if lane { ring } else { corner };
                pixels[out..out + 3].copy_from_slice(&color);
                pixels[out + 3] = 255;
            } else if distance >= 1.0 - thickness / outer {
                // Keep the canvas opaque. Some protocols composite translucent edge pixels against black.
                let edge = ((1.0 - distance) * outer).clamp(0.0, 1.0);
                for channel in 0..3 {
                    let (from, to) = (f64::from(corner[channel]), f64::from(ring[channel]));
                    pixels[out + channel] = round(from + (to - from) * edge) as u8;
                }
                pixels[out + 3] = 255;
            } else {
                let from = y * stride + (x - left) * 4;
                pixels[out..out + 4].copy_from_slice(&source.rgba[from..from + 4]);
            }
        }
    }
    Pixels {
        width: width as u32,
        height: size as u32,
        rgba: pixels,
    }
}

/// Decodes PNG, JPEG, GIF or WebP bytes and scales them to [`AVATAR_SIZE`] square.
pub fn decode_avatar(bytes: &[u8]) -> Result<Pixels, String> {
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let resized = image.resize_exact(
        AVATAR_SIZE,
        AVATAR_SIZE,
        image::imageops::FilterType::Triangle,
    );
    Ok(Pixels {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        rgba: resized.to_rgba8().into_raw(),
    })
}

/// What a GitHub commit lookup found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitHubLookup {
    pub url: Option<String>,
    /// GitHub answered and the commit has no linked account.
    pub confirmed_absent: bool,
    /// Read from a disk entry, which a read must not renew.
    from_cache: bool,
}

/// The network side of avatars.
#[async_trait]
pub trait AvatarFetcher: Send + Sync {
    /// The bytes behind an image URL.
    async fn image(&self, url: &str) -> Result<Vec<u8>, String>;
    /// The avatar URL that `gh api <path>` reports for a commit. `gh` gives authenticated users a higher rate limit.
    async fn gh_commit_avatar(&self, api_path: &str) -> Option<String>;
    /// The avatar URL from GitHub's public API, for when `gh` is unavailable.
    async fn api_commit_avatar(&self, url: &str) -> GitHubLookup;
}

/// Runs `curl` and `gh`.
pub struct SystemFetcher;

impl SystemFetcher {
    async fn curl(args: &[&str]) -> Result<Vec<u8>, String> {
        let output = Command::new("curl")
            .args([
                "-q",
                "--silent",
                "--show-error",
                "--location",
                "--proto",
                "=https",
            ])
            .args(["--max-time", &REQUEST_TIMEOUT.as_secs().to_string()])
            .args(["--user-agent", "tuig"])
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| format!("could not run curl: {error}"))?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }
}

#[async_trait]
impl AvatarFetcher for SystemFetcher {
    async fn image(&self, url: &str) -> Result<Vec<u8>, String> {
        let limit = MAX_AVATAR_BYTES.to_string();
        // `--fail` turns an HTTP error status into a failure. `--max-filesize` rejects an oversized body early.
        Self::curl(&["--fail", "--max-filesize", &limit, url]).await
    }

    async fn gh_commit_avatar(&self, api_path: &str) -> Option<String> {
        let options = GhRunOptions {
            cwd: PathBuf::from("."),
            cancel: None,
        };
        let args = [
            "api".to_string(),
            api_path.to_string(),
            "--jq".to_string(),
            ".author.avatar_url // empty".to_string(),
        ];
        let result = run_program("gh", &args, &options, REQUEST_TIMEOUT)
            .await
            .ok()?;
        let url = result.stdout.trim();
        (result.exit_code == 0 && !url.is_empty()).then(|| url.to_string())
    }

    async fn api_commit_avatar(&self, url: &str) -> GitHubLookup {
        let Ok(body) = Self::curl(&[
            "--fail",
            "--header",
            "Accept: application/vnd.github+json",
            url,
        ])
        .await
        else {
            return GitHubLookup::default();
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return GitHubLookup::default();
        };
        match value["author"]["avatar_url"].as_str() {
            Some(url) => GitHubLookup {
                url: Some(url.to_string()),
                ..GitHubLookup::default()
            },
            None => GitHubLookup {
                confirmed_absent: true,
                ..GitHubLookup::default()
            },
        }
    }
}

fn default_cache_dir() -> PathBuf {
    let home = std::env::var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    home.join("tuig").join("avatars")
}

type KeyedLocks = Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

pub struct AvatarService {
    fetcher: Arc<dyn AvatarFetcher>,
    cache_dir: PathBuf,
    github_urls: Mutex<BoundedCache<String, String>>,
    author_urls: Mutex<BoundedCache<String, String>>,
    decoded: Mutex<BoundedCache<String, Arc<Pixels>>>,
    failed: Mutex<BoundedCache<String, ()>>,
    lookups: Semaphore,
    /// One lock per author or image, so concurrent rows for the same source share one request.
    keyed: KeyedLocks,
    remote: OnceCell<Option<String>>,
}

fn cache<V>(entries: usize, ttl: Duration) -> Mutex<BoundedCache<String, V>> {
    Mutex::new(
        BoundedCache::new(entries, ttl.as_millis() as u64).expect("cache limits are positive"),
    )
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl AvatarService {
    /// A service that caches under `$XDG_CACHE_HOME/tuig/avatars`.
    pub fn new(fetcher: Arc<dyn AvatarFetcher>) -> Self {
        Self::with_cache_dir(fetcher, default_cache_dir())
    }

    pub fn with_cache_dir(fetcher: Arc<dyn AvatarFetcher>, cache_dir: PathBuf) -> Self {
        Self {
            fetcher,
            cache_dir,
            github_urls: cache(METADATA_CACHE_SIZE, AVATAR_CACHE_TTL),
            author_urls: cache(METADATA_CACHE_SIZE, AVATAR_CACHE_TTL),
            decoded: cache(DECODED_CACHE_SIZE, AVATAR_CACHE_TTL),
            failed: cache(METADATA_CACHE_SIZE, AVATAR_MISS_TTL),
            lookups: Semaphore::new(GITHUB_LOOKUP_CONCURRENCY),
            keyed: Mutex::new(HashMap::new()),
            remote: OnceCell::new(),
        }
    }

    /// The remote URL, read once. `graphRemoteUrl`.
    pub async fn remote_url(
        &self,
        read: impl std::future::Future<Output = Option<String>>,
    ) -> Option<String> {
        self.remote.get_or_init(|| read).await.clone()
    }

    /// The avatar for a commit: its GitHub account's photo, else the Gravatar for the author email. `None` when
    /// neither exists, so the painted graph dot stays.
    pub async fn load(&self, remote: Option<&str>, sha: &str, email: &str) -> Option<Arc<Pixels>> {
        let github = self.github_commit_avatar(remote, sha, email).await;
        let mut image = None;
        if let Some(url) = &github {
            image = self.load_image(url).await.ok();
        }
        let gravatar = gravatar_url(email);
        if image.is_none()
            && let Some(url) = &gravatar
        {
            image = self.load_image(url).await.ok();
        }
        image
    }

    /// An avatar from a URL, through the memory and disk caches. Concurrent calls for one URL share one request.
    pub async fn load_image(&self, source: &str) -> Result<Arc<Pixels>, String> {
        if let Some(found) = lock(&self.decoded).get(&source.to_string()) {
            return Ok(found.clone());
        }
        if lock(&self.failed).has(&source.to_string()) {
            return Err("avatar is known to be unavailable".to_string());
        }
        let guard = self.keyed_lock(&format!("img:{source}"));
        let _held = guard.lock().await;
        // The caller that held the lock may have loaded it.
        if let Some(found) = lock(&self.decoded).get(&source.to_string()) {
            return Ok(found.clone());
        }
        match self.load_from_disk_or_network(source).await {
            Ok(pixels) => {
                let pixels = Arc::new(pixels);
                lock(&self.decoded).set(source.to_string(), pixels.clone());
                Ok(pixels)
            }
            Err(error) => {
                lock(&self.failed).set(source.to_string(), ());
                Err(error)
            }
        }
    }

    fn keyed_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = lock(&self.keyed);
        if locks.len() > 1024 {
            locks.retain(|_, held| Arc::strong_count(held) > 1);
        }
        locks.entry(key.to_string()).or_default().clone()
    }

    fn cache_path(&self, source: &str, kind: &str) -> PathBuf {
        self.cache_dir
            .join(format!("{}.{kind}", sha256_hex(source)))
    }

    async fn load_from_disk_or_network(&self, source: &str) -> Result<Pixels, String> {
        let path = self.cache_path(source, "img");
        let age = file_age(&path);
        let stale = age.is_none_or(|age| age >= AVATAR_CACHE_TTL);
        if !stale
            && let Ok(bytes) = std::fs::read(&path)
            && let Ok(pixels) = decode_avatar(&bytes)
        {
            return Ok(pixels);
        }
        let fetched = match self.fetcher.image(source).await {
            Ok(bytes) if bytes.len() as u64 > MAX_AVATAR_BYTES => {
                Err("avatar is too large".to_string())
            }
            other => other,
        };
        match fetched.and_then(|bytes| decode_avatar(&bytes).map(|pixels| (bytes, pixels))) {
            Ok((bytes, pixels)) => {
                write_atomic(&path, &bytes);
                Ok(pixels)
            }
            // A stale image is still useful when the network is unavailable.
            Err(error) => {
                debug_log_error("avatar", &format!("fetch failed for {source}"), &error);
                match std::fs::read(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|b| decode_avatar(&b))
                {
                    Ok(pixels) => Ok(pixels),
                    Err(_) => Err(error),
                }
            }
        }
    }

    /// The avatar URL GitHub associates with a commit. `getGitHubCommitAvatar`.
    pub async fn github_commit_avatar(
        &self,
        remote: Option<&str>,
        sha: &str,
        email: &str,
    ) -> Option<String> {
        let url = github_commit_url(remote, sha)?;
        let email = email.trim().to_lowercase();
        let author = (!email.is_empty()).then(|| author_cache_source(remote.unwrap_or(""), &email));
        let remembered = |service: &Self| {
            if let Some(author) = &author
                && let Some(found) = lock(&service.author_urls).get(author)
            {
                return Some(found.clone());
            }
            let found = lock(&service.github_urls).get(&url).cloned()?;
            if let Some(author) = &author {
                lock(&service.author_urls).set(author.clone(), found.clone());
            }
            Some(found)
        };
        if let Some(found) = remembered(self) {
            return Some(found);
        }
        // One lookup serves every commit by the author. Later callers find it in memory.
        let guard = self.keyed_lock(&format!("gh:{}", author.as_deref().unwrap_or(&url)));
        let _held = guard.lock().await;
        if let Some(found) = remembered(self) {
            return Some(found);
        }
        let result = self.read_github_result(&url, author.as_deref()).await;
        self.cache_github_result(&url, author.as_deref(), &result);
        result.url
    }

    async fn read_github_result(&self, url: &str, author: Option<&str>) -> GitHubLookup {
        let cached = |lookup: Option<CachedSource>| match lookup {
            Some(CachedSource::Miss) => Some(GitHubLookup {
                confirmed_absent: true,
                from_cache: true,
                ..GitHubLookup::default()
            }),
            Some(CachedSource::Hit(url)) => Some(GitHubLookup {
                url: Some(url),
                from_cache: true,
                ..GitHubLookup::default()
            }),
            None => None,
        };
        if let Some(author) = author
            && let Some(found) = cached(self.read_cached_source(author))
        {
            return found;
        }
        // A remembered miss matters more than a hit: GitHub allows 60 unauthenticated requests an hour, and a
        // repository of commits without linked accounts would spend them on every scroll.
        if let Some(found) = cached(self.read_cached_source(url)) {
            return found;
        }
        let Ok(_slot) = self.lookups.acquire().await else {
            return GitHubLookup::default();
        };
        let api_path = url.strip_prefix("https://api.github.com/").unwrap_or(url);
        if let Some(found) = self.fetcher.gh_commit_avatar(api_path).await {
            return GitHubLookup {
                url: Some(found),
                ..GitHubLookup::default()
            };
        }
        debug_log(
            "avatar",
            &format!("gh api returned no avatar for {api_path}"),
        );
        self.fetcher.api_commit_avatar(url).await
    }

    fn cache_github_result(&self, url: &str, author: Option<&str>, result: &GitHubLookup) {
        if let Some(found) = &result.url {
            lock(&self.github_urls).set(url.to_string(), found.clone());
            if let Some(author) = author {
                lock(&self.author_urls).set(author.to_string(), found.clone());
            }
        }
        // A transport failure is not evidence that the author has no avatar, so it leaves both entries alone and
        // the next row retries.
        if !result.from_cache && (result.url.is_some() || result.confirmed_absent) {
            let value = result.url.as_deref().unwrap_or(MISS_MARKER);
            write_atomic(
                &self.cache_path(url, "url"),
                format!("{value}\n").as_bytes(),
            );
            if let Some(author) = author {
                write_atomic(
                    &self.cache_path(author, "url"),
                    format!("{value}\n").as_bytes(),
                );
            }
        }
    }

    fn read_cached_source(&self, source: &str) -> Option<CachedSource> {
        let path = self.cache_path(source, "url");
        let age = file_age(&path)?;
        let text = std::fs::read_to_string(&path).ok()?;
        let value = text.trim();
        if value == MISS_MARKER {
            return (age < AVATAR_MISS_TTL).then_some(CachedSource::Miss);
        }
        (age < AVATAR_CACHE_TTL && value.starts_with("https://"))
            .then(|| CachedSource::Hit(value.to_string()))
    }
}

enum CachedSource {
    Hit(String),
    Miss,
}

fn file_age(path: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(
        SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default(),
    )
}

/// Writes through a temporary file, so a reader never sees half an entry. A failed write only loses the cache.
fn write_atomic(path: &Path, bytes: &[u8]) {
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    if std::fs::write(&temporary, bytes).is_ok() && std::fs::rename(&temporary, path).is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
}

#[cfg(test)]
#[path = "avatars_tests.rs"]
mod tests;
