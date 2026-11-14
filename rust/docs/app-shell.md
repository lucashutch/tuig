# App shell design

This note describes the Rust app shell: the code that owns UI state, starts Git work, receives watcher events, and connects `tuig-ui-model` to OpenTUI widgets. It is tracker item 4. The TS reference is `src/ui/runtime*.ts`. The OpenTUI API references are to the pinned rev `d5c7fca` (`packages/rust/crates/opentui/src`).

## Constraints from OpenTUI

The shell builds on these OpenTUI facts:

- `App::run` runs the UI loop on the main thread. Handlers get `&mut Cx<'_>`. Widgets are `Rc` handles and are not `Send`.
- `App::spawn(future, done)` (`app/tasks.rs:93`) runs `future` on the app's tokio runtime and calls `done(cx, output)` on the UI thread. It returns a `TaskHandle` with `abort()` and `is_finished()`. Abort drops the future. `tuig-git` kills its child processes when the future drops, so abort also stops git.
- `App::proxy()` returns an `AppProxy` that is `Send`. `AppProxy::send(message)` delivers a typed message to handlers registered with `App::on_message::<M>` (`app/proxy.rs:120`, `app/mod.rs:857`). The queue has a fixed capacity and returns `ProxyError::Full` or `ProxyError::Closed`.
- `App::set_timeout` and `App::set_interval` return a `TimerId` that the shell can cancel.
- `Custom<T: Component>` (`widget/custom.rs`) is a widget with a user `paint(&self, painter: &mut Painter<'_>)`, `key`, `paste`, `mouse` (with local coordinates) and `focus_changed`. `Custom::update` changes the component and the next frame repaints it.
- Built-in widgets: `View`, `Text`, `Input`, `Textarea`, `Select`, `Tabs`, `Scroll`, `Diff`, `Code`, `Image`, `Table`, `TextTable`, `Markdown`, `Slider`.
- `App::on_selection` reports a finished text selection and `copy_to_clipboard` sends OSC 52.

The spike (`rust/crates/tuig-spike/src/ui.rs`) already uses `spawn`, `TaskHandle::abort`, `set_timeout` for a 60 ms diff debounce, and `Rc<State>` with `Cell` and `RefCell` fields. The shell keeps this model and makes it explicit.

## Decision summary

- One `Shell` value in `Rc<RefCell<Shell>>` on the UI thread holds all state. No widget holds state that the shell also needs.
- All input goes through one `Msg` enum and one `Shell::update(&mut self, cx, msg)`. Widget callbacks, task completions, timers and watcher events only build a `Msg`.
- Each kind of Git load has a `Slot` with a request id and a `TaskHandle`. A new request aborts the old task and bumps the id. A result with a stale id is dropped.
- The watcher sends events through a tokio channel. A forwarder task posts them to the UI thread as `Msg::Watch`.
- Selection loads (diff, commit files, commit meta) wait for a short debounce. The debounce is a cancelled-and-restarted `TimerId`.
- Painting is a separate pass. `update` changes state and sets dirty flags. `Shell::sync(cx)` then pushes state into widgets once per turn.
- A new crate `tuig-app` holds the shell. `tuig-spike` stays as a reference until screen ports replace it.

## State

The TS `Runtime` class (`src/ui/runtime.ts`) has about 80 fields plus controllers for tabs, palette, popup, themes, file history, pull requests and history columns. The Rust shell groups them by screen area. Each group maps to one TS file.

```rust
pub struct Shell {
    pub tabs: Vec<TabState>,          // runtime-tabs.ts RuntimeTab
    pub active: usize,
    pub repo: Arc<GitRepositoryService>, // active tab's repository
    pub snapshot: Option<Rc<RepositorySnapshot>>,
    pub view: View,                   // tuig_ui_model::runtime_layout::View
    pub history: HistoryState,        // runtime-history.ts, graph index, viewport
    pub files: FilesState,            // runtime-files.ts, file tree, sections
    pub diff: DiffState,              // runtime-diff-selection.ts, runtime-data.ts loadDiff
    pub sidebar: SidebarState,        // runtime-sidebar.ts
    pub composer: ComposerState,      // amend, edit message, busy
    pub overlay: Overlay,             // palette, popup, prompt, picker
    pub layout: LayoutState,          // pane widths, split ratios, last PaneLayout
    pub theme: ThemeState,            // runtime-theme.ts, replaces activeTheme
    pub prefs: Preferences,
    pub tasks: Tasks,
    pub refresh: RefreshState,        // auto-refresh.ts plus watcher
    pub notice: Option<Notice>,       // runtime-notifications.ts
    dirty: Dirty,
    weak_self: Weak<RefCell<Shell>>, // used by Shell::start to build completion callbacks
}

pub struct HistoryState {
    pub index: GraphIndex,      // tuig_ui_model::graph_index
    pub selection: HistorySelection, // Working | Commit(usize)
    pub start: usize,           // first visible row
    pub detached: bool,         // historyViewportDetached
    pub graph_scroll: usize,
    pub limit: usize,           // historyLimit
    pub page_failures: u32,
    pub columns: HistoryColumns,
    pub pending_scroll: i32,
    pub scroll_timer: Option<TimerId>, // 16 ms wheel batching
    pub settle_timer: Option<TimerId>, // 80 ms, hides avatars while scrolling
    pub last_click: Option<(usize, Instant, bool)>, // DOUBLE_CLICK_MS = 400
}

pub enum Overlay {
    None,
    Palette(PaletteState),
    Popup(PopupState),      // menus, confirm, theme picker
    Prompt(PromptState),    // branch name and similar
    RepositoryPicker(PickerState),
    BranchFilter(String),
}

// `tuig-app` adds the `bitflags` dependency.
bitflags::bitflags! {
    struct Dirty: u16 { const LAYOUT = 1; const SIDEBAR = 2; const HISTORY = 4;
        const FILES = 8; const DETAILS = 16; const DIFF = 32; const CHROME = 64; const OVERLAY = 128; }
}
```

`GitRepository` uses native `async fn`, so it is not object safe and `Arc<dyn GitRepository>` does not compile. The shell holds the concrete `Arc<GitRepositoryService>`, as the spike does. Code that needs a fake repository in tests takes a generic `R: GitRepository`.

`Rc<RepositorySnapshot>` replaces the TS identity checks (`ctx.snapshot === snapshot`). A pointer compare with `Rc::ptr_eq` keeps that meaning.

## Messages

```rust
pub enum Msg {
    // Input, built in widget callbacks and App::on_key
    Key(KeyEvent),
    Paste(String),
    HistoryClick { row: usize, column: u16, clicks: u8 },
    HistoryWheel(i32),
    FileClick { section: FileSection, row: usize, column: u16 },
    SidebarClick { row: usize },
    DividerDrag { divider: Divider, at: u16 },
    Resize(u16, u16),
    SelectionCopied(String),
    Command(CommandId), // palette, toolbar, keys all resolve to commands

    // Results from App::spawn, tagged with the request id
    Snapshot(ReqId, GitResult<RepositorySnapshot>),
    WorkingStatus(ReqId, GitResult<WorkingStatus>),
    CommitPage(ReqId, GitResult<CommitPage>),
    CommitFiles(ReqId, GitResult<Vec<ChangedFile>>),
    Diff(ReqId, GitResult<String>),
    Mutation(ReqId, MutationKind, GitResult<()>),
    Avatar(ReqId, AvatarKey, Option<Image>),
    PullRequests(ReqId, PrResult),

    // Timers
    DebounceElapsed(LoadKind),
    ScrollFlush,
    ScrollSettled,
    Poll,
    NoticeExpired,

    // Watcher, built from WatchMsg on the UI thread
    Watch { generation: u64, event: WatchEvent },
}

/// The only type that crosses threads through AppProxy::send, which needs `M: Send`.
/// `Msg` holds `Rc` values and is not `Send`.
pub struct WatchMsg { pub generation: u64, pub event: WatchEvent }
```

The shell registers `app.on_message::<WatchMsg>`. The handler wraps each message into `Msg::Watch { generation, event }` and passes it to `update`.

`Shell::update` matches on `Msg` and calls one function per TS module, for example `history::on_wheel` for `queueHistoryScroll`. Keys go through a port of `runtime-keys.ts` that returns `Option<CommandId>`.

## Git tasks

```rust
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ReqId(u64);

#[derive(Default)]
pub struct Slot { id: u64, task: Option<TaskHandle>, timer: Option<TimerId> }

pub struct Tasks {
    pub snapshot: Slot,
    pub status: Slot,
    pub page: Slot,
    pub commit_files: Slot,
    pub diff: Slot,
    pub mutation: Slot,
    pub avatars: Vec<Slot>, // one per visible graph row
}

impl Shell {
    fn start<F, T>(&mut self, cx: &mut Cx, slot: fn(&mut Tasks) -> &mut Slot,
                   fut: F, wrap: fn(ReqId, T) -> Msg)
    where F: Future<Output = T> + Send + 'static, T: Send + 'static {
        let s = slot(&mut self.tasks);
        if let Some(old) = s.task.take() { old.abort(); }
        s.id += 1;
        let id = ReqId(s.id);
        let shell = self.weak_self.clone();
        s.task = Some(cx.app().spawn(fut, move |cx, out| {
            if let Some(shell) = shell.upgrade() { shell.borrow_mut().update(cx, wrap(id, out)); }
        }));
    }
}
```

Rules:

- Starting a load in a slot aborts the previous task in that slot. This replaces `AbortController` and the counters `diffRequest`, `commitFilesRequest` and `snapshotRequest`.
- A result applies only when its `ReqId` equals the slot's current id. This also covers the case where the task finished before `abort` ran.
- The TS `current()` check in `loadDiff` (`runtime-data.ts:530`) also compares view, mode, comparison base and selected path. In Rust these changes always start a new request in the slot, so the id check is enough. Any code path that changes these fields without a new load must call `Slot::cancel`.
- A tab switch cancels every slot.
- Mutations (`runtime-commands.ts`) use one slot and set `composer.busy`. They are not aborted by selection changes. The user can cancel them, as `cancelActiveMutation` does now.
- `RefCell` borrows: `done` runs outside any `update` call, so `borrow_mut` does not panic.
- Re-entrancy: a widget callback never calls `Shell::update` directly. It pushes a `Msg` into a `VecDeque<Msg>` queue, or posts the `Msg` through the proxy or `cx`. The loop drains the queue after the current handler returns. Each drained `Msg` goes through `update`, and `sync` runs once after the queue is empty. So `sync` never calls `Custom::update` on a widget whose handler is still running, and no handler re-borrows the `RefCell`.

## Watcher

The tracker decision is to change `watch_repository` from callbacks to a channel. The current signature (`tuig-git/src/repository_watcher.rs:207`) takes `on_change: FnMut(Instant) -> bool` and `on_error`. The `bool` return means "cannot refresh yet, ask again later". A channel cannot return a value, so the shell takes over that retry.

```rust
pub enum WatchEvent {
    Changed { at: Instant },
    Failed(notify::Error), // watcher closed itself
}

pub fn watch_repository(
    paths: RepositoryWatchPaths,
    options: RepositoryWatchOptions,
) -> notify::Result<(RepositoryWatcher, mpsc::UnboundedReceiver<WatchEvent>)>;
```

Wiring:

1. On tab activation, the shell creates the watcher on the UI thread and stores `RepositoryWatcher` and a generation number in `RefreshState`. Dropping the watcher closes it.
2. A forwarder task (`app.runtime().spawn`) reads the receiver and calls `proxy.send(WatchMsg { generation, event })`. `on_message::<WatchMsg>` turns each one into `Msg::Watch`. The task ends when the channel closes. On `ProxyError::Full` it keeps only the newest `Changed`, because one refresh covers all of them.
3. `update` drops events from an old generation. This replaces the `generation` counter in `auto-refresh.ts`.
4. On `Changed { at }`, the shell applies `refreshForWatchedChange` (`runtime.ts:1056`) in the same order:
   1. If the composer is open, a refresh is running, or a mutation is busy, store `pending_change = Some(at)`. This is the TS "return false, ask again" case. When the blocking condition clears, the shell checks `pending_change` and runs these steps again.
   2. Otherwise, if a snapshot read started after `at`, skip. That read already includes the change.
   3. Otherwise, start a refresh.
5. On `Failed`, it drops the watcher and polls every 10 s (`FALLBACK_REFRESH_INTERVAL_MS`). With a live watcher it polls every 30 s. Both use `set_interval`.

The burst debounce and the drop of Tuig's own index writes stay inside `tuig-git`.

## Selection debounce

TS loads the diff without a debounce, but it cancels the previous load. The spike debounces diff loads by 60 ms (`DIFF_DEBOUNCE`). The shell uses a debounce for every load that follows the selection:

- Selection change in history: commit files and commit meta.
- Selection change in files: diff.
- Each load kind has its own `Slot.timer`. A new selection cancels the timer and the running task, then calls `set_timeout(DEBOUNCE, |cx| send DebounceElapsed(kind))`.
- The value is 0 ms (off) until the parity harness can wait for loads, so behavior matches TS. The spike uses 60 ms (`DIFF_DEBOUNCE`). Keep the value in one constant. Raise it to 60 ms when the harness waits for loads.
- The UI updates the selection highlight at once. Only the Git load waits.

Wheel scroll keeps the TS timing: a 16 ms batch timer (`queueHistoryScroll`) and an 80 ms settle timer that hides graph avatars while scrolling (`markHistoryScrolling`).

## Leftovers from tuig-ui-model

The tracker lists three pieces that `tuig-ui-model` left out.

- File-tree caches. TS uses `WeakMap` keyed by array identity (`file-tree.ts:134`, `file-tree.ts:150`, `runtime-files.ts:110`). In Rust, `FilesState` stores the built `FileTreeDirectory` for each section next to the `Rc<[ChangedFile]>` it came from. It rebuilds when `Rc::ptr_eq` fails. The flattened rows cache also keys on the expanded set, so it stores a version counter that increments on each `toggle_expansion`.
- Active theme. TS mutates the `activeTheme` singleton in place (`theme.ts:69`). In Rust, `ThemeState` owns the resolved `Theme`. Every painter receives `&Theme` as an argument. On a theme change the shell calls `app.set_theme` for built-in widgets, sets `Dirty::all()`, and `sync` repaints. This replaces `updateWidgetTheme` in `runtime-theme.ts`.
- Pane resize. TS handlers in `runtime-events.ts` and `runtime-layout.ts` change widget sizes directly. In Rust, a divider drag becomes `Msg::DividerDrag`. `update` calls `sidebar_width_for_drag` or `details_width_for_drag` from `tuig_ui_model::runtime_layout`, stores the width in `LayoutState`, and sets `Dirty::LAYOUT`. `sync` calls `layout_panes` and sets widget sizes. Widths save to preferences on release, as TS does now.

## Widget mapping

| TS source | TS renderable | Rust widget |
| --- | --- | --- |
| Root panes (`runtime-widgets.ts` sidebar, history, details boxes) | `BoxRenderable` | `View` with fixed widths from `layout_panes` |
| Tab bar (`runtime-tabs.ts`) | `TextRenderable` with styled spans | `Custom` painter. `Tabs` does not support the close marks and widths. |
| Header, toolbar, hints, footer message (`runtime-toolbar.ts`, `runtime-presentation-chrome.ts`) | `TextRenderable` | `Custom` painters, one row each, with hit regions for buttons |
| Sidebar sections and branch list (`runtime-sidebar.ts`, `runtime-presentation-sidebar.ts`) | `TextRenderable` per section, custom scrollbar | `Custom` painter per section. Scrollbar from `tuig_ui_model::scrollbar`. |
| Pane dividers | `BoxRenderable` with drag | `Custom` painter with `mouse` for drag and hover |
| History graph (`runtime-paint.ts` `paintHistory`, `runtime-history.ts`) | `TextRenderable` plus `ImageRenderable` avatars | `HistoryList` custom painter (tracker item 5), `Image` overlays for avatars |
| History column header (`runtime-history-columns.ts`) | `TextRenderable` | Part of `HistoryList`, or a one-row `Custom` |
| Changed files and file tree (`runtime-files.ts`, `runtime-presentation-changes.ts`) | `TextRenderable` per section | `Custom` painter per section, rows from `flatten_visible` |
| Commit details (`runtime-presentation-commit.ts`) | `BoxRenderable`, `ScrollBoxRenderable`, `TextRenderable`, `ImageRenderable` | `View` and `Scroll` with `Text`, and `Image` for author photo and provider badge |
| Diff pane (`diff-view.ts`, `runtime-diff-selection.ts`) | `DiffView` wrapping `DiffRenderable` | `Diff`. Line mapping from `tuig-spike/src/mapping.rs`. Gaps: no per-row highlight, first file only, no word diff (tracker item 6). |
| Composer summary and body | `InputRenderable`, `TextareaRenderable` | `Input`, `Textarea` |
| Commit and amend buttons, working banner | `TextRenderable` with mouse | `Custom` one-row painters |
| Command palette (`runtime-palette.ts`) | `BoxRenderable`, `InputRenderable`, `TextRenderable` | `View` overlay with `Input` and a `Custom` result list. Matching from `tuig_ui_model::command_palette`. |
| Popup menus, confirm, theme picker (`runtime-popup.ts`, `graph-menu.ts`) | `BoxRenderable`, `TextRenderable`, overlay catcher box | `View` overlay with a `Custom` list. A full-screen `Custom` behind it catches outside clicks. |
| Branch filter, name prompt, repository picker | `InputRenderable` | `Input` in an overlay `View` |
| Spinner and notices (`runtime-notifications.ts`) | `TextRenderable` with timer | Footer painter, `set_interval` for the spinner, `set_timeout` for the 6 s clear |

I prefer `Custom` painters over `Select` for lists. `Select` scrolls the selection on wheel instead of the viewport (tracker item 6), and the TS lists draw icons, chips and per-span colors that `SelectOption` cannot express.

## History list widget interface (item 5)

`HistoryList` is a `Custom<HistoryListComponent>` that the shell feeds with `set_rows(Rc<[GraphRow]>)` (from `tuig_ui_model::graph`), `set_viewport(start: usize)`, `set_selected(Option<usize>)` and `set_theme(&Theme)`, and that reports only `HistoryEvent::{Click { row, column, clicks }, Wheel(i32)}` through one callback, so the shell owns all scroll and selection state.

Current state: the widget owns no viewport or selection. The shell keeps `HistorySelection` and `HistoryViewport` (`tuig_ui_model::history_viewport`) and the `GraphIndex`. It builds a `HistoryWindow` (the commit rows on screen, their graph rows and ref labels) with `tuig_widgets::history::history_window` and passes it with `set_window`, which replaces `set_rows` and `set_viewport`. The widget also has `set_selected(Option<usize>)`, `set_graph_scroll` and `set_theme`. It reports `HistoryEvent::{Click { row, column, clicks }, Wheel(i32), ScrollGraph(i32)}` through `on_event`. The widget counts double clicks itself, so `HistoryState` has no `last_click`.

## Crate layout

```
rust/crates/
  tuig-git/        async Git layer (exists)
  tuig-ui-model/   non-render logic (exists)
  tuig-widgets/    Custom components: HistoryList, file tree list, sidebar section, one-row bars, list overlay
  tuig-app/        binary "tuig": Shell, Msg, update, sync, tasks, watcher wiring, CLI
    src/main.rs        argument parsing, App::new, GitRepositoryService::open
    src/shell.rs       Shell, Msg, update dispatch
    src/tasks.rs       Slot, ReqId, start
    src/refresh.rs     watcher forwarder, poll timers
    src/sync.rs        dirty flags to widget updates
    src/keys.rs        port of runtime-keys.ts
    src/screens/       one module per TS runtime-* area
  tuig-spike/      kept until item 7 ports its screens, then removed
```

Target: `tuig-widgets` depends on `opentui` and `tuig-ui-model`, not on `tuig-git`. It can then have headless tests with `app/headless.rs`. Current state: on `feature/rust-history-widget` it also depends on `tuig-git` for `Commit` and `BranchRef` (`decorations.rs`). Remove that dependency in the same follow-up, for example by moving the needed fields into `tuig-ui-model` types. If item 5 lands in `tuig-spike` first, move it into `tuig-widgets` when `tuig-app` starts.

## Open questions

- When can the selection debounce move from 0 to 60 ms? TS has no debounce, so a parity capture right after a key press differs. The harness must wait for loads first.
- `PROXY_CAPACITY` is 4096 (`app/proxy.rs:7`), and `spawn` completions use the same queue (`app/tasks.rs`). Avatar loads for a long scroll could compete with watcher events. Decide whether to cap concurrent avatar tasks.
- Should the watcher API keep a retry signal (`on_change` returning `false`) inside `tuig-git`, or is the shell-side `pending_change` enough? This note picks the shell side.
- Graph avatars use one `ImageRenderable` per visible row in TS. Check that OpenTUI Rust `Image` can be placed over a `Custom` painter row and replaced without flicker in Kitty-protocol terminals.
- Background tabs: TS watches only the active tab and reads a fresh snapshot on switch. Keep that, or keep per-tab snapshots in memory?
- `Diff` gaps (per-row highlight, multi-file patches, word diff) may force a custom diff painter. Decide after the upstream issues in item 6.
- Text width for painters: `Painter::text_width` exists. Check whether it agrees with `Bun.stringWidth` before choosing a separate crate for item 3's open text-width task.
