use super::*;
use crate::avatars::{AvatarFetcher, GitHubLookup};
use crate::screens::history::{SCROLL_BATCH, SCROLL_SETTLE};
use crate::screens::test_support::{Harness, TempDir, repository};
use crate::services::Services;
use std::sync::atomic::{AtomicUsize, Ordering};
use tuig_widgets::history::ClickPart;

/// One PNG for every URL. No test touches the network.
struct FakeFetcher {
    png: Vec<u8>,
    image_calls: AtomicUsize,
    /// A URL containing this text fails to load.
    reject: Option<&'static str>,
    requested: std::sync::Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl AvatarFetcher for FakeFetcher {
    async fn image(&self, url: &str) -> Result<Vec<u8>, String> {
        self.image_calls.fetch_add(1, Ordering::SeqCst);
        self.requested.lock().unwrap().push(url.to_string());
        if self.reject.is_some_and(|text| url.contains(text)) {
            return Err("offline".to_string());
        }
        Ok(self.png.clone())
    }
    async fn gh_commit_avatar(&self, _api_path: &str) -> Option<String> {
        None
    }
    async fn api_commit_avatar(&self, _url: &str) -> GitHubLookup {
        GitHubLookup::default()
    }
}

fn png() -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(8, 8, image::Rgba([10, 200, 30, 255]));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn visible_slots(shell: &Shell) -> usize {
    shell
        .avatars
        .slots
        .iter()
        .filter(|slot| slot.view.as_ref().is_some_and(|view| view.is_visible()))
        .count()
}

fn start(commits: usize) -> (Harness, Arc<FakeFetcher>, TempDir) {
    start_with(repository(commits), None)
}

fn start_with(repo: TempDir, reject: Option<&'static str>) -> (Harness, Arc<FakeFetcher>, TempDir) {
    let fetcher = Arc::new(FakeFetcher {
        png: png(),
        image_calls: AtomicUsize::new(0),
        reject,
        requested: Default::default(),
    });
    let cache = TempDir::new("avatar-cache");
    let service = AvatarService::with_cache_dir(fetcher.clone(), cache.0.clone());
    let h = Harness::start(
        repo,
        Services {
            avatars: Some(Arc::new(service)),
            avatars_enabled: true,
            ..Services::default()
        },
    );
    // The test terminal reports no graphics, so bypass the check.
    h.shell.borrow_mut().avatars.graphics_override = Some(true);
    (h, fetcher, cache)
}

#[test]
fn authors_show_over_their_graph_dots_and_hide_while_the_wheel_scrolls() {
    let (h, fetcher, _cache) = start(80);
    h.shell.borrow_mut().dirty |= Dirty::AVATARS;
    h.wait("avatars on every body line", |shell| {
        visible_slots(shell) >= 40
    });
    assert_eq!(
        fetcher.image_calls.load(Ordering::SeqCst),
        1,
        "one author, one download"
    );

    h.send(Msg::HistoryWheel(3));
    h.app.advance(SCROLL_BATCH);
    h.wait("the scroll", |shell| {
        shell.history.viewport.start == 3 && shell.history.scrolling
    });
    assert_eq!(
        h.read(visible_slots),
        0,
        "images stay hidden during a wheel gesture"
    );

    h.app.advance(SCROLL_SETTLE);
    h.wait("avatars again", |shell| visible_slots(shell) >= 40);
    assert_eq!(
        fetcher.image_calls.load(Ordering::SeqCst),
        1,
        "the decoded photo is shared by every commit of the author"
    );
}

#[test]
fn a_late_result_for_a_released_slot_is_dropped() {
    let (h, _fetcher, _cache) = start(2);
    h.shell.borrow_mut().dirty |= Dirty::AVATARS;
    h.wait("avatars", |shell| visible_slots(shell) == 2);
    let late = h.read(|shell| {
        let slot = &shell.avatars.slots[1];
        AvatarLoaded {
            slot: 1,
            token: slot.token - 1,
            key: slot.key.clone().unwrap(),
            canvas: Some(Pixels {
                width: 1,
                height: 1,
                rgba: vec![0, 0, 0, 255],
            }),
        }
    });
    let before = h.read(|shell| shell.avatars.rendered.len());
    h.send(Msg::GraphAvatar(late));
    assert_eq!(h.read(|shell| shell.avatars.rendered.len()), before);
}

#[test]
fn a_disabled_preference_keeps_the_painted_dots() {
    let (h, fetcher, _cache) = start(3);
    h.shell.borrow_mut().avatars.enabled = false;
    h.shell.borrow_mut().dirty |= Dirty::AVATARS;
    h.send(Msg::Poll);
    h.wait("the refresh", |shell| !shell.tasks.snapshot.busy());
    assert_eq!(h.read(visible_slots), 0);
    assert_eq!(fetcher.image_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn the_commit_details_show_the_author_photo_in_place_of_the_initials() {
    let (h, fetcher, _cache) = start(3);
    h.wait("the first snapshot", |shell| shell.snapshot.is_some());
    h.send(Msg::HistoryClick {
        row: 1,
        part: ClickPart::Row,
        clicks: 1,
    });
    h.wait("the author photo", |shell| {
        shell.widgets.details_view.photo_shown()
    });
    assert_eq!(fetcher.image_calls.load(Ordering::SeqCst), 1);

    // Another commit has its own load.
    h.send(Msg::HistoryClick {
        row: 2,
        part: ClickPart::Row,
        clicks: 1,
    });
    assert!(
        !h.read(|shell| shell.widgets.details_view.photo_shown()),
        "the old photo does not stay behind"
    );
    h.wait("the next commit's photo", |shell| {
        shell.widgets.details_view.photo_shown()
    });
    h.send(Msg::Details(
        crate::screens::details::DetailsAction::ViewWorking,
    ));
    assert!(!h.read(|shell| shell.widgets.details_view.photo_shown()));
}

/// A repository whose newest commit has `trailers` in its message.
fn repository_with_trailers(trailers: &str) -> TempDir {
    let repo = repository(2);
    let message = format!("commit 1\n\n{trailers}\n");
    let status = std::process::Command::new("git")
        .args(["commit", "-q", "--amend", "--allow-empty", "-m", &message])
        .current_dir(&repo.0)
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.com")
        .status()
        .unwrap();
    assert!(status.success());
    repo
}

fn open_newest(h: &Harness) {
    h.wait("the first snapshot", |shell| shell.snapshot.is_some());
    h.send(Msg::HistoryClick {
        row: 0,
        part: ClickPart::Row,
        clicks: 1,
    });
}

const CLAUDE_TRAILER: &str = "Co-authored-by: Claude <noreply@anthropic.com>";

#[test]
fn a_claude_co_author_gets_a_provider_badge_beside_its_name() {
    let (h, fetcher, _cache) = start_with(repository_with_trailers(CLAUDE_TRAILER), None);
    open_newest(&h);
    h.wait("the provider badge", |shell| {
        shell.widgets.details_view.provider_shown()
    });
    assert!(h.read(|shell| shell.avatars.provider_badge().visible));
    let requested = fetcher.requested.lock().unwrap().clone();
    assert!(
        requested.iter().any(|url| url.contains("Claude-ai-icon")),
        "{requested:?}"
    );

    h.send(Msg::HistoryClick {
        row: 1,
        part: ClickPart::Row,
        clicks: 1,
    });
    h.wait("the badge to leave with the commit", |shell| {
        !shell.widgets.details_view.provider_shown()
    });
    assert!(!h.read(|shell| shell.avatars.provider_badge().visible));
}

#[test]
fn a_provider_badge_that_fails_to_load_gives_its_room_back() {
    let (h, _fetcher, _cache) = start_with(
        repository_with_trailers(CLAUDE_TRAILER),
        Some("Claude-ai-icon"),
    );
    open_newest(&h);
    h.wait("the failed load", |shell| {
        shell.avatars.provider.task.is_none() && shell.avatars.provider.sha.is_some()
    });
    assert!(!h.read(|shell| shell.widgets.details_view.provider_shown()));
    let badge = h.read(|shell| shell.avatars.provider_badge());
    assert!(badge.graphics && !badge.visible, "{badge:?}");
}

#[test]
fn human_co_authors_and_a_terminal_without_graphics_get_no_badge() {
    let (h, fetcher, _cache) = start_with(
        repository_with_trailers("Co-authored-by: Grace <grace@example.com>"),
        None,
    );
    open_newest(&h);
    h.wait("the details", |shell| shell.details_commit().is_some());
    assert!(!h.read(|shell| shell.avatars.provider_badge().visible));
    assert!(h.read(|shell| shell.avatars.provider_badge().graphics));
    assert!(!h.read(|shell| shell.widgets.details_view.provider_shown()));
    let _ = &fetcher;

    let (h, _fetcher, _cache) = start_with(repository_with_trailers(CLAUDE_TRAILER), None);
    h.shell.borrow_mut().avatars.graphics_override = Some(false);
    open_newest(&h);
    h.wait("the details", |shell| shell.details_commit().is_some());
    assert_eq!(
        h.read(|shell| shell.avatars.provider_badge()),
        ProviderBadge::default()
    );
}
