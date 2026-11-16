//! The outside services the shell talks to. Each one is optional, so tests run with none of them and never touch
//! the network.

use crate::avatars::{AvatarService, SystemFetcher};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tuig_git::pull_request_types::PullRequestService;
use tuig_git::pull_requests::GhPullRequestService;
use tuig_ui_model::preferences::{LayoutPreferences, layout_preferences_path};

/// Opens a web page in the browser. [`SystemOpener`] runs `xdg-open`. Tests use none, so they never open a browser.
#[async_trait::async_trait]
pub trait UrlOpener: Send + Sync {
    async fn open(&self, url: &str) -> Result<(), String>;
}

pub struct SystemOpener;

#[async_trait::async_trait]
impl UrlOpener for SystemOpener {
    async fn open(&self, url: &str) -> Result<(), String> {
        tuig_cli::open_url(url)
            .await
            .map_err(|error| error.to_string())
    }
}

/// Minutes between background fetches when no preference sets it. `DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES`.
pub const DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES: f64 = 1.0;

#[derive(Clone, Default)]
pub struct Services {
    /// Without it the pull request panel, column and spinner stay off.
    pub pull_requests: Option<Arc<dyn PullRequestService>>,
    /// Without it graph avatars stay off.
    pub avatars: Option<Arc<AvatarService>>,
    /// Whether the saved preferences allow avatars. `avatarsEnabled`.
    pub avatars_enabled: bool,
    /// Time between background `git fetch --prune` runs. `None` turns them off.
    pub fetch_interval: Option<Duration>,
    /// Without it a pull request does not open in the browser.
    pub url_opener: Option<Arc<dyn UrlOpener>>,
    /// The saved layout to restore at start.
    pub layout: LayoutPreferences,
    /// Where layout changes are saved. Without it they stay in memory.
    pub layout_path: Option<PathBuf>,
}

impl Services {
    /// The real services for the repository at `root`, configured by the saved layout preferences.
    pub fn system(root: &str, preferences: &LayoutPreferences) -> Self {
        let minutes = preferences
            .remote_fetch_interval_minutes
            .unwrap_or(DEFAULT_REMOTE_FETCH_INTERVAL_MINUTES);
        Self {
            pull_requests: Some(Arc::new(GhPullRequestService::new(root))),
            avatars: Some(Arc::new(AvatarService::new(Arc::new(SystemFetcher)))),
            avatars_enabled: preferences.avatars_enabled.unwrap_or(true),
            fetch_interval: (minutes > 0.0).then(|| Duration::from_secs_f64(minutes * 60.0)),
            url_opener: Some(Arc::new(SystemOpener)),
            layout: preferences.clone(),
            layout_path: Some(layout_preferences_path()),
        }
    }
}
