use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn png(color: [u8; 4]) -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(8, 8, image::Rgba(color));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

/// Answers from a table and counts every call. No test touches the network.
#[derive(Default)]
struct Fake {
    images: Mutex<HashMap<String, Vec<u8>>>,
    gh: Mutex<Option<String>>,
    api: Mutex<GitHubLookup>,
    image_calls: AtomicUsize,
    gh_calls: AtomicUsize,
    api_calls: AtomicUsize,
}

#[async_trait]
impl AvatarFetcher for Fake {
    async fn image(&self, url: &str) -> Result<Vec<u8>, String> {
        self.image_calls.fetch_add(1, Ordering::SeqCst);
        lock(&self.images)
            .get(url)
            .cloned()
            .ok_or("offline".to_string())
    }
    async fn gh_commit_avatar(&self, _api_path: &str) -> Option<String> {
        self.gh_calls.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        lock(&self.gh).clone()
    }
    async fn api_commit_avatar(&self, _url: &str) -> GitHubLookup {
        self.api_calls.fetch_add(1, Ordering::SeqCst);
        lock(&self.api).clone()
    }
}

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tuig-avatars-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const REMOTE: &str = "git@github.com:acme/widgets.git";
const AVATAR: &str = "https://avatars.githubusercontent.com/u/1";

fn service(fake: &Arc<Fake>, dir: &TempDir) -> AvatarService {
    AvatarService::with_cache_dir(fake.clone(), dir.0.clone())
}

#[test]
fn urls_follow_the_typescript_rules() {
    assert_eq!(
        gravatar_url("  Test@Example.com ").unwrap(),
        "https://www.gravatar.com/avatar/973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b?s=64&d=404"
    );
    assert_eq!(gravatar_url("not an email"), None);
    for remote in [
        "git@github.com:acme/widgets.git",
        "https://github.com/acme/widgets",
        "https://user@github.com:443/acme/widgets.git/",
        "ssh://git@github.com/acme/widgets",
    ] {
        assert_eq!(
            github_commit_url(Some(remote), "abc").as_deref(),
            Some("https://api.github.com/repos/acme/widgets/commits/abc"),
            "{remote}"
        );
    }
    assert_eq!(
        github_commit_url(Some("https://gitlab.com/acme/widgets"), "abc"),
        None
    );
    assert_eq!(
        github_commit_url(Some("https://github.com/acme"), "abc"),
        None
    );
    assert_eq!(github_commit_url(None, "abc"), None);
}

#[test]
fn wsl_needs_a_terminal_with_native_graphics() {
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    };
    assert!(terminal_graphics_supported(PixelProtocol::Kitty, env(&[])));
    assert!(!terminal_graphics_supported(
        PixelProtocol::Blocks,
        env(&[])
    ));
    assert!(!terminal_graphics_supported(
        PixelProtocol::Kitty,
        env(&[("WSL_DISTRO_NAME", "Ubuntu")])
    ));
    assert!(terminal_graphics_supported(
        PixelProtocol::Kitty,
        env(&[("WSL_DISTRO_NAME", "Ubuntu"), ("WEZTERM_PANE", "1")])
    ));
    assert!(terminal_graphics_supported(
        PixelProtocol::Sixel,
        env(&[("WSL_INTEROP", "/run/x"), ("TERM", "xterm-kitty")])
    ));
}

fn solid(color: [u8; 4]) -> Pixels {
    Pixels {
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        rgba: color.repeat((AVATAR_SIZE * AVATAR_SIZE) as usize),
    }
}

fn at(pixels: &Pixels, x: u32, y: u32) -> [u8; 4] {
    let from = ((y * pixels.width + x) * 4) as usize;
    pixels.rgba[from..from + 4].try_into().unwrap()
}

#[test]
fn the_circle_keeps_the_photo_inside_and_the_lane_stripe_outside() {
    let options = |above, below| CircleOptions {
        ring: Rgba::rgb(200, 10, 10),
        background: Rgba::rgb(40, 44, 52),
        continues_above: above,
        continues_below: below,
    };
    let canvas = circular_avatar(&solid([1, 2, 3, 255]), &options(true, false));
    assert_eq!(
        (canvas.width, canvas.height),
        (72, 48),
        "3:2 canvas for a three by one cell box"
    );
    assert_eq!(at(&canvas, 36, 24), [1, 2, 3, 255], "photo at the centre");
    assert_eq!(
        at(&canvas, 0, 0),
        [40, 44, 52, 255],
        "corners take the row background"
    );
    assert_eq!(
        at(&canvas, 35, 0),
        [200, 10, 10, 255],
        "the lane continues above"
    );
    assert_eq!(
        at(&canvas, 35, 47),
        [40, 44, 52, 255],
        "no stripe below a last commit"
    );
    assert!(
        canvas.rgba.chunks(4).all(|pixel| pixel[3] == 255),
        "the canvas is opaque"
    );
    let both = circular_avatar(&solid([1, 2, 3, 255]), &options(true, true));
    assert_eq!(at(&both, 35, 47), [200, 10, 10, 255]);
}

#[tokio::test]
async fn one_github_lookup_serves_every_commit_by_an_author() {
    let (fake, dir) = (Arc::new(Fake::default()), TempDir::new());
    *lock(&fake.gh) = Some(AVATAR.to_string());
    lock(&fake.images).insert(AVATAR.to_string(), png([9, 9, 9, 255]));
    let avatars = service(&fake, &dir);
    let (a, b, c) = tokio::join!(
        avatars.load(Some(REMOTE), "sha1", "Ada@Example.com"),
        avatars.load(Some(REMOTE), "sha2", "ada@example.com"),
        avatars.load(Some(REMOTE), "sha3", "ada@example.com"),
    );
    assert_eq!(
        fake.gh_calls.load(Ordering::SeqCst),
        1,
        "the author is looked up once"
    );
    assert_eq!(
        fake.image_calls.load(Ordering::SeqCst),
        1,
        "the image is fetched once"
    );
    assert_eq!(b.unwrap(), c.unwrap());
    assert_eq!(at(&a.unwrap(), 24, 24), [9, 9, 9, 255]);
}

#[tokio::test]
async fn a_confirmed_miss_is_remembered_on_disk_across_runs() {
    let (fake, dir) = (Arc::new(Fake::default()), TempDir::new());
    *lock(&fake.api) = GitHubLookup {
        confirmed_absent: true,
        ..GitHubLookup::default()
    };
    let gravatar = gravatar_url("ada@example.com").unwrap();
    lock(&fake.images).insert(gravatar, png([5, 5, 5, 255]));
    let first = service(&fake, &dir)
        .load(Some(REMOTE), "sha1", "ada@example.com")
        .await;
    assert!(first.is_some(), "the Gravatar covers a missing account");
    assert_eq!(fake.api_calls.load(Ordering::SeqCst), 1);

    // A new service has empty memory but reads the same cache directory.
    let again = service(&fake, &dir)
        .load(Some(REMOTE), "sha2", "ada@example.com")
        .await;
    assert!(again.is_some());
    assert_eq!(
        fake.gh_calls.load(Ordering::SeqCst),
        1,
        "no second lookup for a known miss"
    );
    assert_eq!(fake.api_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        fake.image_calls.load(Ordering::SeqCst),
        1,
        "the image came from disk"
    );
}

#[tokio::test]
async fn a_transport_failure_is_retried_on_the_next_row() {
    let (fake, dir) = (Arc::new(Fake::default()), TempDir::new());
    let avatars = service(&fake, &dir);
    assert!(
        avatars
            .load(Some(REMOTE), "sha1", "ada@example.com")
            .await
            .is_none()
    );
    assert!(
        avatars
            .load(Some(REMOTE), "sha2", "ada@example.com")
            .await
            .is_none()
    );
    assert_eq!(
        fake.api_calls.load(Ordering::SeqCst),
        2,
        "no miss was written for a failed lookup"
    );
}

#[tokio::test]
async fn a_stale_image_is_used_when_the_network_is_down() {
    let (fake, dir) = (Arc::new(Fake::default()), TempDir::new());
    lock(&fake.images).insert(AVATAR.to_string(), png([7, 7, 7, 255]));
    let avatars = service(&fake, &dir);
    avatars.load_image(AVATAR).await.unwrap();
    let file = avatars.cache_path(AVATAR, "img");
    let old = SystemTime::now() - AVATAR_CACHE_TTL - Duration::from_secs(60);
    std::fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(old)
        .unwrap();
    lock(&fake.images).clear();

    let fresh_memory = service(&fake, &dir);
    let pixels = fresh_memory.load_image(AVATAR).await.unwrap();
    assert_eq!(at(&pixels, 24, 24), [7, 7, 7, 255]);
    assert_eq!(
        fake.image_calls.load(Ordering::SeqCst),
        2,
        "a stale file is refreshed first"
    );
}

#[tokio::test]
async fn a_failed_image_is_not_requested_again() {
    let (fake, dir) = (Arc::new(Fake::default()), TempDir::new());
    let avatars = service(&fake, &dir);
    assert!(avatars.load_image(AVATAR).await.is_err());
    assert!(avatars.load_image(AVATAR).await.is_err());
    assert_eq!(fake.image_calls.load(Ordering::SeqCst), 1);
}

/// Every row was produced by `getProviderAvatarUrl` in `src/ui/avatars.ts` (run with bun), so the table pins the
/// Rust regexes to the TypeScript ones, including the word boundaries around `.com` and the names.
#[test]
fn provider_avatars_follow_the_typescript_rules() {
    const CLAUDE: &str = "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Claude-ai-icon.svg/120px-Claude-ai-icon.svg.png";
    const OPENAI: &str = "https://github.com/openai.png?size=64";
    let table: &[(&str, &str, Option<&str>)] = &[
        ("Claude", "noreply@anthropic.com", Some(CLAUDE)),
        ("Claude Opus 4.5", "noreply@anthropic.com", Some(CLAUDE)),
        ("Someone", "dev@anthropic.com", Some(CLAUDE)),
        ("Someone", "dev@mail.anthropic.com", Some(CLAUDE)),
        ("Someone", "dev@notanthropic.com", None),
        ("Someone", "dev@anthropic.community", None),
        ("Someone", "dev@anthropic.com.au", Some(CLAUDE)),
        ("Claude Code", "a@b.co", Some(CLAUDE)),
        ("claudette", "a@b.co", None),
        ("Claude-Code", "a@b.co", Some(CLAUDE)),
        ("Claudé", "a@b.co", None),
        ("xclaude", "a@b.co", None),
        ("Ada", "claude_bot@example.com", None),
        ("Ada", "claude.bot@example.com", Some(CLAUDE)),
        ("Ada", "claude@example.com", Some(CLAUDE)),
        ("ChatGPT", "noreply@openai.com", Some(OPENAI)),
        ("Codex", "codex@openai.com", Some(OPENAI)),
        ("OpenAI Codex", "a@b.co", Some(OPENAI)),
        ("Ada", "ada@openai.com", Some(OPENAI)),
        ("Ada", "ada@my.openai.com", Some(OPENAI)),
        ("Ada", "ada@myopenai.com", None),
        ("ChatGPT-4", "a@b.co", Some(OPENAI)),
        ("chatgpts", "a@b.co", None),
        ("Ada", "ada@openai.community", Some(OPENAI)),
        ("Claude", "noreply@openai.com", Some(CLAUDE)),
        ("ChatGPT", "noreply@anthropic.com", Some(CLAUDE)),
        ("Ada Lovelace", "ada@example.com", None),
        ("", "anthropic.com", None),
        ("anthropic.com", "", Some(CLAUDE)),
        ("ANTHROPIC.COM Bot", "X@Y.Z", Some(CLAUDE)),
        ("Ada", "ada@sub.OpenAI.com", Some(OPENAI)),
        ("İclaude", "a@b.co", Some(CLAUDE)),
        ("Ada", "ada@anthropic.com_", None),
        ("Ada", "ada@anthropic.com-x", Some(CLAUDE)),
        ("Ada", "ada@anthropic.com1", None),
    ];
    for (name, email, expected) in table {
        assert_eq!(
            provider_avatar_url(name, email),
            *expected,
            "{name:?} <{email}>"
        );
    }
}
