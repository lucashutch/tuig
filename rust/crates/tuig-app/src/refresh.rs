//! Refresh after repository changes: the watcher forwarder, the poll timers, and `refreshForWatchedChange`
//! (`src/ui/runtime.ts`) with the retry that `watch_repository` used to do itself.

use crate::shell::{GitResult, Inbox, Msg, Shell};
use opentui::app::ProxyError;
use opentui::prelude::*;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::mpsc::error::TryRecvError;
use tuig_git::repository_watcher::{
    RepositoryWatchOptions, RepositoryWatcher, WatchEvent, watch_repository,
};
use tuig_git::types::RepositoryWatchPaths;

/// Poll interval while the watcher runs. `auto-refresh.ts`.
pub const WATCHED_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
/// Poll interval without a watcher. `FALLBACK_REFRESH_INTERVAL_MS`.
pub const FALLBACK_REFRESH_INTERVAL: Duration = Duration::from_secs(10);
/// Wait before sending again when the app's queue is full.
const PROXY_RETRY: Duration = Duration::from_millis(10);

/// A watcher report as the UI thread sees it. `notify::Error` is not `Clone`, so a failure carries its message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchSignal {
    Changed { at: Instant },
    Failed(String),
}

/// The only type that crosses threads through `AppProxy::send`. `Msg` holds non-`Send` values.
#[derive(Debug, Clone)]
pub struct WatchMsg {
    pub generation: u64,
    pub event: WatchSignal,
}

#[derive(Default)]
pub struct RefreshState {
    pub watcher: Option<RepositoryWatcher>,
    /// Bumped for each new watcher. Events from an older one are dropped.
    pub generation: u64,
    pub poll: Option<TimerId>,
    /// A change seen while a refresh could not start. Checked again when the blocking refresh ends.
    pub pending_change: Option<Instant>,
    /// A refresh asked for while one was running.
    pub pending_refresh: bool,
}

/// Turns watcher messages from the forwarder into [`Msg::Watch`].
pub fn install(app: &App, inbox: &Rc<Inbox>) {
    let inbox = inbox.clone();
    app.on_message::<WatchMsg>(move |cx, message| {
        inbox.post(
            cx.app(),
            Msg::Watch {
                generation: message.generation,
                event: message.event.clone(),
            },
        );
    });
}

fn signal(event: WatchEvent) -> WatchSignal {
    match event {
        WatchEvent::Changed { at } => WatchSignal::Changed { at },
        WatchEvent::Failed(error) => WatchSignal::Failed(error.to_string()),
    }
}

/// Reads watcher reports and posts them to the UI thread until the channel closes. When the queue is full it
/// waits and keeps only the newest report, because one refresh covers every change before it.
async fn forward(
    mut events: UnboundedReceiver<WatchEvent>,
    proxy: opentui::app::AppProxy,
    generation: u64,
) {
    while let Some(event) = events.recv().await {
        let mut message = WatchMsg {
            generation,
            event: signal(event),
        };
        loop {
            match proxy.send(message.clone()) {
                Ok(()) => break,
                Err(ProxyError::Closed) => return,
                Err(ProxyError::Full) => {
                    tokio::time::sleep(PROXY_RETRY).await;
                    loop {
                        match events.try_recv() {
                            Ok(event) => message.event = signal(event),
                            Err(TryRecvError::Empty) => break,
                            Err(TryRecvError::Disconnected) => break,
                        }
                    }
                }
            }
        }
    }
}

impl Shell {
    pub(crate) fn start_watch_paths(&mut self, app: &App) {
        let repo = self.repo.clone();
        self.spawn(
            app,
            |tasks| &mut tasks.watch_paths,
            async move { repo.watch_paths().await },
            Msg::WatchPaths,
        );
    }

    pub(crate) fn watch_paths_loaded(
        &mut self,
        app: &App,
        result: GitResult<Option<RepositoryWatchPaths>>,
    ) {
        let paths = match result {
            Ok(Some(paths)) => paths,
            Ok(None) => return self.poll_every(app, FALLBACK_REFRESH_INTERVAL),
            Err(error) => {
                self.notice = Some(error.to_string());
                return self.poll_every(app, FALLBACK_REFRESH_INTERVAL);
            }
        };
        let runtime = app.runtime();
        let started = {
            let _guard = runtime.enter();
            watch_repository(paths, RepositoryWatchOptions::default())
        };
        match started {
            Ok((watcher, events)) => {
                self.refresh.generation += 1;
                self.refresh.watcher = Some(watcher);
                runtime.spawn(forward(events, app.proxy(), self.refresh.generation));
                self.poll_every(app, WATCHED_REFRESH_INTERVAL);
            }
            Err(error) => {
                self.notice = Some(error.to_string());
                self.poll_every(app, FALLBACK_REFRESH_INTERVAL);
            }
        }
    }

    fn poll_every(&mut self, app: &App, interval: Duration) {
        if let Some(timer) = self.refresh.poll.take() {
            app.cancel_timer(timer);
        }
        let inbox = self.inbox.clone();
        self.refresh.poll =
            Some(app.set_interval(interval, move |cx| inbox.post(cx.app(), Msg::Poll)));
    }

    pub(crate) fn watch_event(&mut self, app: &App, generation: u64, event: WatchSignal) {
        if generation != self.refresh.generation {
            return;
        }
        match event {
            WatchSignal::Changed { at } => self.watched_change(app, at),
            WatchSignal::Failed(error) => {
                self.refresh.watcher = None;
                self.notice = Some(error);
                self.poll_every(app, FALLBACK_REFRESH_INTERVAL);
            }
        }
    }

    /// Ports `refreshForWatchedChange`: wait while a refresh runs, skip when a read started after the change, and
    /// otherwise refresh.
    fn watched_change(&mut self, app: &App, at: Instant) {
        // TODO: the composer-open and mutation-busy checks join this condition once those features exist.
        if self.tasks.snapshot.busy() {
            self.refresh.pending_change = Some(at);
            return;
        }
        if self
            .tasks
            .snapshot
            .started_at()
            .is_some_and(|started| started > at)
        {
            return;
        }
        self.request_refresh(app, true);
    }

    /// Ports `refresh`. A manual refresh while one runs waits for it and then runs again. An automatic one is
    /// dropped, because the running read covers it or `pending_change` asks again.
    pub(crate) fn request_refresh(&mut self, app: &App, automatic: bool) {
        if self.tasks.snapshot.busy() {
            if !automatic {
                self.refresh.pending_refresh = true;
            }
            return;
        }
        self.start_snapshot(app);
    }

    /// Runs when a snapshot result was applied or failed, and starts any refresh that waited for it.
    pub(crate) fn snapshot_finished(&mut self, app: &App) {
        if std::mem::take(&mut self.refresh.pending_refresh) {
            self.refresh.pending_change = None;
            self.start_snapshot(app);
        } else if let Some(at) = self.refresh.pending_change.take() {
            self.watched_change(app, at);
        }
    }
}
