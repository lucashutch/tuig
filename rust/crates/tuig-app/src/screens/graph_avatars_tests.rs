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
}

#[async_trait::async_trait]
impl AvatarFetcher for FakeFetcher {
    async fn image(&self, _url: &str) -> Result<Vec<u8>, String> {
        self.image_calls.fetch_add(1, Ordering::SeqCst);
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
    let fetcher = Arc::new(FakeFetcher {
        png: png(),
        image_calls: AtomicUsize::new(0),
    });
    let cache = TempDir::new("avatar-cache");
    let service = AvatarService::with_cache_dir(fetcher.clone(), cache.0.clone());
    let h = Harness::start(
        repository(commits),
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
