//! Author avatars over the graph dots. Ports `updateGraphAvatars` and `loadGraphAvatar` in
//! `src/ui/runtime-data.ts`.
//!
//! The history widget says which dots can carry an avatar ([`HistoryList::avatar_slots`]). The shell keeps one
//! [`ImageView`] per body line. A slot keeps its commit until another commit claims it, so a repaint without a
//! scroll never fetches again. An image never moves to another row: moving a terminal image placement can leave its
//! pixels at the old row in Kitty and similar protocols, so the slot index is the line.
//!
//! The painted graph dot stays visible while a photo loads, and for authors without a photo.
//!
//! Gaps against TS: the avatar background ignores row hover, so a hovered row shows the corners of the image in the
//! unhovered color. Avatars do not appear in the commit details pane yet.

use crate::avatars::{
    AvatarService, CircleOptions, PixelProtocol, Pixels, circular_avatar,
    terminal_graphics_supported,
};
use crate::shell::{Dirty, Msg, PANE_TOP, Shell};
use opentui::app::TaskHandle;
use opentui::input::MouseEventKind;
use opentui::native::{Image, ImageFit, ImageProtocol};
use opentui::prelude::*;
use opentui::widget::{Component, ImageView};
use std::sync::Arc;
use tuig_git::repository::GitRepository;
use tuig_widgets::history::{AvatarSlot, HistoryList};

/// Pooled image widgets. `GRAPH_AVATAR_SLOT_LIMIT`.
const SLOT_LIMIT: usize = 512;
/// Rendered canvases kept for reuse. `GRAPH_AVATAR_CACHE_SIZE`.
const RENDERED_CACHE: usize = 256;

#[derive(Default)]
struct SlotState {
    /// What the slot shows or loads. `None` for an idle slot.
    key: Option<String>,
    task: Option<TaskHandle>,
    /// Bumped on every claim, so a result for an earlier claim is dropped.
    token: u64,
    view: Option<ImageView>,
}

impl SlotState {
    fn release(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.token += 1;
    }
}

#[derive(Default)]
pub struct AvatarState {
    pub service: Option<Arc<AvatarService>>,
    /// The `avatarsEnabled` preference.
    pub enabled: bool,
    /// Tests set this to skip the terminal graphics check, which the test terminal always fails.
    #[cfg(test)]
    pub graphics_override: Option<bool>,
    slots: Vec<SlotState>,
    /// Least recently used first.
    rendered: Vec<(String, Image)>,
    photo: PhotoState,
}

/// The author photo in the commit details pane. `loadAuthorPhoto`.
#[derive(Default)]
struct PhotoState {
    /// The commit the photo is for or loads for.
    sha: Option<String>,
    /// Bumped on every change of commit, so a result for an earlier commit is dropped.
    token: u64,
    task: Option<TaskHandle>,
}

/// What a finished author photo load hands the UI thread.
pub struct PhotoLoaded {
    pub token: u64,
    pub pixels: Option<Arc<Pixels>>,
}

impl AvatarState {
    pub fn new(service: Option<Arc<AvatarService>>, enabled: bool) -> Self {
        Self {
            service,
            enabled,
            ..Self::default()
        }
    }
}

/// What a finished load hands the UI thread: the masked canvas, or `None` when the author has no avatar.
pub struct AvatarLoaded {
    pub slot: usize,
    pub token: u64,
    pub key: String,
    pub canvas: Option<Pixels>,
}

/// Identity of a painted avatar: source, lane color, row stripe, lane ends. `graphAvatarKey`.
fn avatar_key(identity: &str, slot: &AvatarSlot) -> String {
    format!(
        "{identity}|{}|{}|{}{}",
        slot.color.to_hex(),
        slot.background.to_hex(),
        u8::from(slot.continues_above),
        u8::from(slot.continues_below)
    )
}

/// The protocol OpenTUI picks for an image: a forced one, else Kitty or Sixel as the terminal reports, else
/// blocks. Tmux gets blocks, because OpenTUI does not pass graphics through it.
fn effective_protocol(app: &App) -> PixelProtocol {
    use opentui::native::{CapabilityFlags, Multiplexer};
    let Ok(capabilities) = app.session().capabilities() else {
        return PixelProtocol::Blocks;
    };
    match capabilities.image_protocol {
        ImageProtocol::Kitty => PixelProtocol::Kitty,
        ImageProtocol::Sixel => PixelProtocol::Sixel,
        ImageProtocol::Blocks => PixelProtocol::Blocks,
        ImageProtocol::Auto => {
            if capabilities.multiplexer != Multiplexer::None {
                PixelProtocol::Blocks
            } else if capabilities.flags.contains(CapabilityFlags::KITTY_GRAPHICS) {
                PixelProtocol::Kitty
            } else if capabilities.flags.contains(CapabilityFlags::SIXEL) {
                PixelProtocol::Sixel
            } else {
                PixelProtocol::Blocks
            }
        }
    }
}

impl Shell {
    /// Block-drawn avatars are too coarse at this size, so the painted dots stay unless real graphics work.
    /// `avatarSupported`.
    fn avatars_supported(&self, app: &App) -> bool {
        #[cfg(test)]
        if let Some(forced) = self.avatars.graphics_override {
            return forced && self.avatars.enabled && self.avatars.service.is_some();
        }
        self.avatars.enabled
            && self.avatars.service.is_some()
            && terminal_graphics_supported(effective_protocol(app), |name| std::env::var(name).ok())
    }

    /// Points the pooled images at the dots on screen. Runs from `sync` when the history, layout or diff changed.
    /// A diff over the history pane and a running wheel gesture hide every image. `updateGraphAvatars`.
    pub(crate) fn sync_graph_avatars(&mut self, app: &App) {
        let hidden = self.diff.is_open() || self.history.scrolling;
        let supported = self.avatars_supported(app);
        let wanted: Vec<AvatarSlot> = if hidden || !supported {
            Vec::new()
        } else {
            let (width, height) = (
                u32::try_from(self.layout.panes.history_content_width.max(0)).unwrap_or(0),
                u32::try_from(self.layout.panes.history_text_height.max(0)).unwrap_or(0),
            );
            self.widgets
                .history
                .with(|list| list.avatar_slots(width, height))
        };
        let highest = wanted.iter().map(|slot| slot.line + 1).max().unwrap_or(0);
        let count = highest.max(self.avatars.slots.len()).min(SLOT_LIMIT);
        if self.avatars.slots.len() < count {
            self.avatars.slots.resize_with(count, SlotState::default);
        }
        let left = self.layout.panes.history_content_left;
        for line in 0..count {
            let request = wanted.iter().find(|slot| slot.line == line);
            let Some(request) = request else {
                self.release_avatar_slot(line);
                continue;
            };
            let view = self.avatar_view(app, line);
            let _ = view
                .position(
                    Edge::Left,
                    u32::try_from((left + request.left).max(0)).unwrap_or(0),
                )
                .position(
                    Edge::Top,
                    u32::try_from((i64::from(PANE_TOP) + request.top).max(0)).unwrap_or(0),
                );
            self.claim_avatar_slot(app, line, request);
        }
    }

    fn release_avatar_slot(&mut self, line: usize) {
        let slot = &mut self.avatars.slots[line];
        if slot.key.is_none() {
            return;
        }
        slot.key = None;
        slot.release();
        if let Some(view) = &slot.view {
            let _ = view.visible(false);
            let _ = view.image(None);
        }
    }

    fn claim_avatar_slot(&mut self, app: &App, line: usize, request: &AvatarSlot) {
        // The lane color is part of the key: a commit that moved lanes gets its avatar masked again.
        let key = avatar_key(&request.sha, request);
        if self.avatars.slots[line].key.as_deref() == Some(&key) {
            return;
        }
        let slot = &mut self.avatars.slots[line];
        slot.key = Some(key.clone());
        slot.release();
        if let Some(view) = &slot.view {
            let _ = view.visible(false);
            let _ = view.image(None);
        }
        if let Some(position) = self
            .avatars
            .rendered
            .iter()
            .position(|(cached, _)| *cached == key)
        {
            let entry = self.avatars.rendered.remove(position);
            self.show_avatar(line, &entry.1);
            self.avatars.rendered.push(entry);
            return;
        }
        let Some(service) = self.avatars.service.clone() else {
            return;
        };
        let repo = self.repo.clone();
        let (token, request) = (self.avatars.slots[line].token, request.clone());
        let inbox = self.inbox.clone();
        let task = app.spawn(
            load_graph_avatar(service, repo, request, line, token, key),
            move |cx, loaded| inbox.post(cx.app(), Msg::GraphAvatar(loaded)),
        );
        self.avatars.slots[line].task = Some(task);
    }

    /// A load finished. The result applies only when the slot still holds the same claim. `showGraphAvatar`.
    pub(crate) fn graph_avatar_loaded(&mut self, app: &App, loaded: AvatarLoaded) {
        let Some(slot) = self.avatars.slots.get_mut(loaded.slot) else {
            return;
        };
        if slot.token != loaded.token || slot.key.as_deref() != Some(&loaded.key) {
            return;
        }
        slot.task = None;
        let Some(canvas) = loaded.canvas else {
            return;
        };
        let context = app.session().context().clone();
        let Ok(image) = Image::from_rgba(&context, canvas.width, canvas.height, &canvas.rgba)
        else {
            return;
        };
        self.avatars.rendered.push((loaded.key, image.clone()));
        if self.avatars.rendered.len() > RENDERED_CACHE {
            self.avatars.rendered.remove(0);
        }
        self.show_avatar(loaded.slot, &image);
    }

    fn show_avatar(&self, line: usize, image: &Image) {
        if let Some(view) = &self.avatars.slots[line].view {
            let _ = view.image(Some(image.clone()));
            let _ = view.visible(true);
        }
    }

    /// The image widget for a line, created on first use. Presses and wheel events pass to the history list, which
    /// the image covers. `onMouseDown` in `ensureGraphAvatarSlots`.
    fn avatar_view(&mut self, app: &App, line: usize) -> ImageView {
        if let Some(view) = &self.avatars.slots[line].view {
            return view.clone();
        }
        let history = self.widgets.history.clone();
        let view = ImageView::new(app)
            .absolute()
            .size(3, 1)
            .fit(ImageFit::Fill)
            .visible(false)
            .on_mouse(move |cx, event| {
                // Click and wheel only. Hover stays with the row highlight, which the list moves itself.
                if matches!(
                    event.kind,
                    MouseEventKind::Down(_) | MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
                ) {
                    let rect = history.rect();
                    let local = (
                        i32::from(event.x) - rect.screen_x as i32,
                        i32::from(event.y) - rect.screen_y as i32,
                    );
                    history.update(|list: &mut HistoryList| list.mouse(cx, event, local));
                }
            });
        app.root().add(&view);
        self.avatars.slots[line].view = Some(view.clone());
        view
    }

    /// Releases every in-flight load and hides the images, for the avatar toggle. `cancelGraphAvatars`.
    pub(crate) fn clear_graph_avatars(&mut self) {
        for line in 0..self.avatars.slots.len() {
            self.release_avatar_slot(line);
        }
        self.dirty |= Dirty::HISTORY;
    }
}

impl Shell {
    /// Starts or drops the author photo load so it follows the commit in the details pane. Without graphics or
    /// with avatars off the initials badge stays. `showCommitMeta`.
    pub(crate) fn sync_author_photo(&mut self, app: &App) {
        let wanted = if self.avatars_supported(app) {
            self.details_commit()
                .map(|commit| (commit.sha.clone(), commit.author_email.clone()))
        } else {
            None
        };
        let photo = &mut self.avatars.photo;
        if photo.sha.as_deref() == wanted.as_ref().map(|(sha, _)| sha.as_str()) {
            return;
        }
        photo.sha = wanted.as_ref().map(|(sha, _)| sha.clone());
        photo.token += 1;
        if let Some(task) = photo.task.take() {
            task.abort();
        }
        self.widgets.details_view.set_photo(None);
        let (Some((sha, email)), Some(service)) = (wanted, self.avatars.service.clone()) else {
            return;
        };
        let (repo, token) = (self.repo.clone(), self.avatars.photo.token);
        let inbox = self.inbox.clone();
        let task = app.spawn(
            async move {
                let remote = service.remote_url(repo.remote_url()).await;
                PhotoLoaded {
                    token,
                    pixels: service.load(remote.as_deref(), &sha, &email).await,
                }
            },
            move |cx, loaded| inbox.post(cx.app(), Msg::AuthorPhoto(loaded)),
        );
        self.avatars.photo.task = Some(task);
    }

    pub(crate) fn author_photo_loaded(&mut self, app: &App, loaded: PhotoLoaded) {
        if loaded.token != self.avatars.photo.token {
            return;
        }
        self.avatars.photo.task = None;
        let Some(pixels) = loaded.pixels else {
            return;
        };
        let context = app.session().context().clone();
        if let Ok(image) = Image::from_rgba(&context, pixels.width, pixels.height, &pixels.rgba) {
            self.widgets.details_view.set_photo(Some(&image));
        }
    }
}

/// Loads an avatar and masks it for one dot. Runs off the UI thread. `loadGraphAvatar`.
async fn load_graph_avatar(
    service: Arc<AvatarService>,
    repo: Arc<dyn GitRepository>,
    request: AvatarSlot,
    slot: usize,
    token: u64,
    key: String,
) -> AvatarLoaded {
    let remote = service.remote_url(repo.remote_url()).await;
    let canvas = service
        .load(remote.as_deref(), &request.sha, &request.author_email)
        .await
        .map(|avatar| {
            circular_avatar(
                &avatar,
                &CircleOptions {
                    ring: request.color,
                    background: request.background,
                    continues_above: request.continues_above,
                    continues_below: request.continues_below,
                },
            )
        });
    AvatarLoaded {
        slot,
        token,
        key,
        canvas,
    }
}

#[cfg(test)]
#[path = "graph_avatars_tests.rs"]
mod tests;

impl Shell {
    /// The avatar toggle. Off releases the graph images and drops the author photo, on loads them again.
    pub(crate) fn set_avatars_enabled(&mut self, enabled: bool) {
        self.avatars.enabled = enabled;
        if !enabled {
            self.clear_graph_avatars();
        }
        self.dirty |= Dirty::AVATARS | Dirty::HISTORY | Dirty::DETAILS;
    }
}
