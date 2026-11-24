//! The spike UI: history list, diff pane, filter input, and commit composer, wired to tuig-git through Tokio.

use crate::mapping::{self, Side, Target};
use opentui::app::TaskHandle;
use opentui::prelude::*;
use opentui::syntax::filetype_for_path;
use opentui::widget::{
    Diff, DiffView, EditorAction, Input, Select, SelectOption, Textarea, View, Widget,
};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use tuig_git::repository::{GitRepository, GitRepositoryService};
use tuig_git::types::{Commit, DiffRequest};

/// Rows per history page.
const PAGE: usize = 500;
/// Pause after the selection stops moving before the diff loads.
const DIFF_DEBOUNCE: Duration = Duration::from_millis(60);

pub struct Options {
    /// Load pages until the list holds this many commits (or history ends).
    pub rows: usize,
}

pub struct State {
    repo: Arc<GitRepositoryService>,
    rows_wanted: usize,
    commits: RefCell<Vec<Commit>>,
    /// Indexes into `commits` for the rows the list shows (the filter hides the others).
    visible: RefCell<Vec<usize>>,
    complete: Cell<bool>,
    paging: Cell<bool>,
    filter: RefCell<String>,
    diff_timer: Cell<Option<TimerId>>,
    diff_task: RefCell<Option<TaskHandle>>,
    /// The commit whose diff the pane shows or is loading.
    pub diff_sha: RefCell<Option<String>>,
    pub last_click: RefCell<Option<Target>>,
    pub frames_text: Cell<u64>,
}

/// The widgets, kept for tests that drive them.
#[cfg_attr(not(test), allow(dead_code))]
pub struct Ui {
    pub state: Rc<State>,
    pub history: Select,
    pub diff: Diff,
    pub status: Text,
    pub filter: Input,
    pub composer: Textarea,
}

fn option(commit: &Commit) -> SelectOption {
    let refs = if commit.decorations.is_empty() {
        String::new()
    } else {
        format!(" ({})", commit.decorations.join(", "))
    };
    SelectOption::new(
        format!(
            "{} {}{}",
            &commit.sha[..commit.sha.len().min(8)],
            commit.subject,
            refs
        ),
        format!("{} {}", commit.author, commit.authored_at),
    )
}

impl State {
    fn rebuild_list(&self, history: &Select) {
        let filter = self.filter.borrow().to_lowercase();
        let commits = self.commits.borrow();
        let visible: Vec<usize> = commits
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                filter.is_empty()
                    || c.subject.to_lowercase().contains(&filter)
                    || c.sha.starts_with(&filter)
            })
            .map(|(i, _)| i)
            .collect();
        history.options(visible.iter().map(|&i| option(&commits[i])));
        *self.visible.borrow_mut() = visible;
    }

    pub fn commit_count(&self) -> usize {
        self.commits.borrow().len()
    }
}

/// Builds the widgets and starts the first load. Everything runs on the UI thread except the git futures.
pub fn build(app: &App, repo: GitRepositoryService, options: Options) -> Ui {
    let state = Rc::new(State {
        repo: Arc::new(repo),
        rows_wanted: options.rows,
        commits: RefCell::new(Vec::new()),
        visible: RefCell::new(Vec::new()),
        complete: Cell::new(false),
        paging: Cell::new(false),
        filter: RefCell::new(String::new()),
        diff_timer: Cell::new(None),
        diff_task: RefCell::new(None),
        diff_sha: RefCell::new(None),
        last_click: RefCell::new(None),
        frames_text: Cell::new(0),
    });
    let theme = app.theme();

    let history = Select::new(app)
        .grow(1.0)
        .show_description(true)
        .show_scroll_indicator(true);
    let diff = Diff::new(app).grow(1.0).view(DiffView::Unified);
    let status = Text::new(app, "Loading...").fg(theme.muted).height(1);
    let filter = Input::new(app)
        .placeholder("filter subject or sha")
        .height(1);
    let composer = Textarea::new(app)
        .placeholder("Commit message (ctrl+s submits)")
        .bind("ctrl+s", EditorAction::Submit)
        .grow(1.0);

    let left = View::new(app)
        .border(BorderStyle::Rounded)
        .title(" History ")
        .width(Length::percent(40.0))
        .child(&history);
    let right = View::new(app)
        .border(BorderStyle::Rounded)
        .title(" Diff ")
        .grow(1.0)
        .child(&diff);
    let top = View::new(app).row().grow(1.0).child(&left).child(&right);
    let filter_box = View::new(app)
        .border(BorderStyle::Rounded)
        .title(" Filter ")
        .width(Length::percent(40.0))
        .height(3)
        .child(&filter);
    let composer_box = View::new(app)
        .border(BorderStyle::Rounded)
        .title(" Commit ")
        .grow(1.0)
        .child(&composer);
    let bottom = View::new(app)
        .row()
        .height(6)
        .child(&filter_box)
        .child(&composer_box);
    app.root().add(&top).add(&bottom).add(&status);

    // History selection loads a diff, debounced so wheel and key repeats do not start a git process per row.
    {
        let (state, app_handle, diff, status) =
            (state.clone(), app.clone(), diff.clone(), status.clone());
        history.on_change(move |cx, index, _option| {
            if let Some(timer) = state.diff_timer.take() {
                app_handle.cancel_timer(timer);
            }
            let (state2, diff2, status2) = (state.clone(), diff.clone(), status.clone());
            let id = cx.app().set_timeout(DIFF_DEBOUNCE, move |cx| {
                load_diff(cx.app(), &state2, index, &diff2, &status2)
            });
            state.diff_timer.set(Some(id));
        });
    }
    // Near the end of the loaded rows, fetch the next page.
    {
        let (state, history2, status) = (state.clone(), history.clone(), status.clone());
        history.on_change(move |cx, index, _| {
            let len = state.visible.borrow().len();
            if index + 50 >= len {
                load_page(cx.app(), &state, &history2, &status);
            }
        });
    }
    {
        let (state, history2) = (state.clone(), history.clone());
        filter.on_submit(move |_cx, text| {
            *state.filter.borrow_mut() = text.to_owned();
            state.rebuild_list(&history2);
        });
    }
    {
        let (state, history2) = (state.clone(), history.clone());
        filter.on_change(move |_cx, text| {
            *state.filter.borrow_mut() = text.to_owned();
            state.rebuild_list(&history2);
        });
    }
    {
        let status = status.clone();
        composer.on_submit(move |_cx, text| {
            status.set_text(format!(
                "composer submit: {} bytes, {} lines",
                text.len(),
                text.lines().count()
            ));
        });
    }
    // Click in the diff: map the row to a file line.
    {
        let (state, diff2, status2) = (state.clone(), diff.clone(), status.clone());
        diff.on_click(move |_cx, event| {
            let target = target_at(&state, &diff2, event.x, event.y);
            *state.last_click.borrow_mut() = target;
            status2.set_text(match target {
                Some(t) => format!(
                    "click: hunk {} {:?} {:?} line {} (raw row {})",
                    t.hunk, t.kind, t.side, t.line, t.raw_row
                ),
                None => "click: no diff line".to_owned(),
            });
        });
    }
    install_keys(app, &state, &history, &diff, &status, &filter, &composer);
    history.focus();

    start(app, &state, &history, &status);
    Ui {
        state,
        history,
        diff,
        status,
        filter,
        composer,
    }
}

fn install_keys(
    app: &App,
    _state: &Rc<State>,
    history: &Select,
    diff: &Diff,
    status: &Text,
    filter: &Input,
    composer: &Textarea,
) {
    let (history, diff, status, filter, composer) = (
        history.clone(),
        diff.clone(),
        status.clone(),
        filter.clone(),
        composer.clone(),
    );
    let split = Cell::new(false);
    let current = Cell::new(0usize);
    app.on_key(move |cx, key| {
        // Printable keys never reach here while an editor has focus: the editor consumes them.
        if key.matches("q") {
            cx.quit();
        } else if key.matches("u") {
            split.set(!split.get());
            diff.view(if split.get() {
                DiffView::Split
            } else {
                DiffView::Unified
            });
            status.set_text(if split.get() {
                "split view"
            } else {
                "unified view"
            });
        } else if key.matches("d") {
            history.show_description(false);
        } else if key.matches("]") || key.matches("[") {
            let hunks = diff.hunk_lines();
            if hunks.is_empty() {
                return;
            }
            let at = if key.matches("]") {
                (current.get() + 1).min(hunks.len() - 1)
            } else {
                current.get().saturating_sub(1)
            };
            current.set(at);
            let (left, right) = diff.code_views();
            left.scroll_to(hunks[at]);
            right.scroll_to(hunks[at]);
            status.set_text(format!("hunk {}/{}", at + 1, hunks.len()));
        } else if key.matches("/") {
            filter.focus();
        } else if key.matches("c") {
            composer.focus();
        } else if key.matches("escape") {
            history.focus();
        }
    });
}

fn start(app: &App, state: &Rc<State>, history: &Select, status: &Text) {
    let repo = state.repo.clone();
    let (state, history, status) = (state.clone(), history.clone(), status.clone());
    app.spawn(
        async move { repo.snapshot(PAGE).await },
        move |cx, result| match result {
            Ok(snapshot) => {
                status.set_text(format!(
                    "{} on {} | {} changed files | {} commits",
                    snapshot.root,
                    snapshot.branch.as_deref().unwrap_or("(detached)"),
                    snapshot.files.len(),
                    snapshot.commits.len()
                ));
                state.complete.set(snapshot.commits_complete);
                *state.commits.borrow_mut() = snapshot.commits;
                state.rebuild_list(&history);
                maybe_prefetch(cx.app(), &state, &history, &status);
            }
            Err(error) => {
                status.set_text(format!("snapshot failed: {error}"));
            }
        },
    );
}

fn maybe_prefetch(app: &App, state: &Rc<State>, history: &Select, status: &Text) {
    if state.commit_count() < state.rows_wanted {
        load_page(app, state, history, status);
    }
}

fn load_page(app: &App, state: &Rc<State>, history: &Select, status: &Text) {
    if state.complete.get() || state.paging.replace(true) {
        return;
    }
    let repo = state.repo.clone();
    let skip = state.commit_count();
    let (state, history, status) = (state.clone(), history.clone(), status.clone());
    app.spawn(
        async move { repo.commit_page(PAGE, skip).await },
        move |cx, result| {
            state.paging.set(false);
            match result {
                Ok(page) => {
                    state.complete.set(page.complete);
                    state.commits.borrow_mut().extend(page.commits);
                    state.rebuild_list(&history);
                    status.set_text(format!("{} commits loaded", state.commit_count()));
                    maybe_prefetch(cx.app(), &state, &history, &status);
                }
                Err(error) => drop(status.set_text(format!("history page failed: {error}"))),
            }
        },
    );
}

fn load_diff(app: &App, state: &Rc<State>, index: usize, diff: &Diff, status: &Text) {
    state.diff_timer.set(None);
    let Some(&commit_index) = state.visible.borrow().get(index) else {
        return;
    };
    let sha = state.commits.borrow()[commit_index].sha.clone();
    // A newer selection aborts the running load: dropping the future cancels the git children.
    if let Some(previous) = state.diff_task.borrow_mut().take() {
        previous.abort();
    }
    *state.diff_sha.borrow_mut() = Some(sha.clone());
    let repo = state.repo.clone();
    let request_sha = sha.clone();
    let (diff, status, state2) = (diff.clone(), status.clone(), state.clone());
    let handle = app.spawn(
        async move {
            let files = repo.commit_files(&request_sha, None).await?;
            let Some(file) = files.first() else {
                return Ok((String::new(), String::new()));
            };
            let patch = repo
                .diff(&DiffRequest {
                    commit: Some(request_sha),
                    path: Some(file.path.clone()),
                    ..Default::default()
                })
                .await?;
            Ok::<_, tuig_git::process::GitError>((file.path.clone(), patch))
        },
        move |_cx, result| match result {
            Ok((path, patch)) => {
                diff.filetype(filetype_for_path(&path)).set_diff(patch);
                let (left, right) = diff.code_views();
                left.scroll_to(0);
                right.scroll_to(0);
                state2.frames_text.set(state2.frames_text.get() + 1);
                status.set_text(format!("{} {path}", &sha[..8.min(sha.len())]));
            }
            Err(error) => drop(status.set_text(format!("diff failed: {error}"))),
        },
    );
    *state.diff_task.borrow_mut() = Some(handle);
}

/// Maps a screen cell inside the diff to a file line, using `Diff::hunk_lines` and the code views' geometry.
pub fn target_at(_state: &State, diff: &Diff, x: u16, y: u16) -> Option<Target> {
    let (left, right) = diff.code_views();
    let patch = diff.diff();
    let split = right.rect().width > 0.0 && right.rect().screen_x > left.rect().screen_x;
    let (view, side) = if split && f64::from(x) >= right.rect().screen_x {
        (&right, Side::New)
    } else {
        (&left, Side::Old)
    };
    let rect = view.rect();
    let (fx, fy) = (f64::from(x), f64::from(y));
    if fy < rect.screen_y || fy >= rect.screen_y + f64::from(rect.height) || fx < rect.screen_x {
        return None;
    }
    let row = (fy - rect.screen_y) as u32 + view.scroll_position();
    if split {
        mapping::split_target(&patch, row, side)
    } else {
        mapping::unified_target(&patch, row, &diff.hunk_lines())
    }
}
