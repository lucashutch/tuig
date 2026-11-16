//! The commit details pane, file and line history, and line blame. Ports `showCommitMeta`, `openCommit` and
//! `closeDiff` in `src/ui/runtime-data.ts`, the commit card layout in `src/ui/runtime-layout.ts`, and
//! `src/ui/runtime-file-history.ts`.
//!
//! The commit text comes from the commits the history already holds, so selecting a commit needs no Git call and
//! there is nothing to go stale. The Git calls here are file history, line history and blame. Each has a task slot,
//! so a newer request or a close drops the result of an older one.
//!
//! Entry points for the screens that are not ported yet: [`Shell::show_file_history`],
//! [`Shell::show_line_history`] and [`Shell::blame_line`]. In TS the graph menu starts them, from the file context
//! menu ("Show file history") and from a diff line ("Blame line N", "Show history for line N").
//!
//! Gaps against the TS app:
//!
//! - The provider badge for co-authors. The author photo is in `graph_avatars.rs`. Its initials badge shows while the
//!   photo loads and when graphics are off, as in TS.
//! - The message card scrolls with the wheel, but the scrollbar of its `ScrollBox` is not checked against TS.
//! - Compare mode (`openComparison`) does nothing yet. "Edit Message" opens the composer (`screens/composer.rs`).
//! - TS drops an in-flight file history when a refresh replaces the snapshot. Here a result applies unless a newer
//!   request or a close replaced it.

use crate::screens::composer::ComposerAction;
use crate::screens::files::Contents;
use crate::shell::{Dirty, GitResult, Inbox, Msg, PANE_TOP, Shell};
use opentui::native::{Image, ImageFit};
use opentui::prelude::*;
use opentui::widget::{ImageView, ScrollBox, Text, View};
use std::rc::Rc;
use tuig_git::types::{ChangedFile, Commit, LineBlame};
use tuig_ui_model::color::Rgba;
use tuig_ui_model::history_viewport::HistorySelection;
use tuig_ui_model::runtime_layout::{
    DetailsInputs, DetailsLayout, details, details_info_width, details_label_gap,
    details_text_width, file_history_split, layout_details,
};
use tuig_ui_model::text_width::{fit_columns, string_width};
use tuig_ui_model::theme::Theme;
use tuig_widgets::commit_text::{
    CoAuthor, CommitText, author_avatar, boxed_author_avatar, parse_co_authors,
    present_commit_text, short_sha, working_changes_banner_lines, working_changes_banner_rows,
    wrapped_line_count,
};
use tuig_widgets::file_history::{CARD_ROWS, FileHistoryEvent, FileHistoryList};

/// What a click in the details pane asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetailsAction {
    /// The `DETAILS` label copies the selected history commit's SHA. `copyCommitSha`.
    CopySha,
    /// The working-changes banner. `viewWorkingChanges`, which is `closeDiff`.
    ViewWorking,
}

/// An open file or line history. `RuntimeFileHistoryController.filter`.
pub struct FileHistory {
    /// The file the history is for. The diff pane loads the selected commit's diff of it.
    #[allow(dead_code)]
    pub file: ChangedFile,
    pub commits: Rc<[Commit]>,
    pub index: usize,
    /// The first card on screen.
    pub start: usize,
    /// The 1-based line for a line history, `None` for a file history.
    pub line: Option<usize>,
}

impl FileHistory {
    pub fn selected_commit(&self) -> Option<&Commit> {
        self.commits.get(self.index)
    }
}

#[derive(Default)]
pub struct DetailsState {
    pub file_history: Option<FileHistory>,
}

/// The result of a file or line history request, with what asked for it.
pub struct HistoryLoaded {
    pub file: ChangedFile,
    pub line: Option<usize>,
    pub result: GitResult<Vec<Commit>>,
}

/// What [`DetailsView::show`] draws.
pub struct DetailsInput<'a> {
    pub commit: &'a Commit,
    pub working_files: usize,
    pub pane_width: i64,
    /// Rows below the tab strip and toolbar.
    pub content_height: i64,
    pub history: Option<&'a FileHistory>,
}

fn color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

fn cells(value: i64) -> u32 {
    u32::try_from(value.max(0)).unwrap_or(0)
}

fn flow(text: &Text) -> Text {
    text.position(Edge::Left, 1u32).width(Length::percent(95.0))
}

/// The widgets of the details pane's top part: the working banner, the message card and the identity card, plus
/// the file history list. Their positions are relative to the details pane.
pub struct DetailsView {
    theme: Theme,
    banner: Text,
    message_box: ScrollBox,
    message_label: Text,
    edit_button: Text,
    header: Text,
    body: Text,
    info_box: View,
    info_label: Text,
    info: Text,
    photo: ImageView,
    badge: Text,
    co_authors: Text,
    history_label: Text,
    history_list: Custom<FileHistoryList>,
}

impl DetailsView {
    pub fn new(app: &App, theme: &Theme, inbox: &Rc<Inbox>) -> Self {
        let text = |content: &str, fg: Rgba| Text::new(app, content).fg(color(fg));
        let banner = text("", theme.warning)
            .absolute()
            .position(Edge::Left, 1u32)
            .position(Edge::Top, 0u32)
            .width(Length::percent(97.0))
            .height(1u32)
            .wrap(WrapMode::None)
            .visible(false);
        {
            let inbox = inbox.clone();
            banner.on_click(move |cx, _| {
                inbox.post(cx.app(), Msg::Details(DetailsAction::ViewWorking));
            });
        }
        let message_box = ScrollBox::new(app)
            .absolute()
            .position(Edge::Left, 1u32)
            .width(Length::percent(97.0))
            .direction(FlexDirection::Column)
            // The colors the TS ScrollBox draws its bar with (@opentui/core defaults).
            .scrollbar_colors(Color::rgb(0x9a, 0x9e, 0xa3), Color::rgb(0x25, 0x25, 0x27))
            .visible(false);
        message_box.wrapper_view().bg(color(theme.panel_raised));
        message_box.content_view().bg(color(theme.panel_raised));
        let message_label = flow(&text("COMMIT MESSAGE", theme.text)).height(1u32);
        let edit_button = Text::new(
            app,
            vec![
                " Edit Message "
                    .fg(color(theme.accent))
                    .bg(color(theme.selected)),
            ],
        )
        .absolute()
        .position(Edge::Top, 0u32)
        .width(16u32)
        .height(1u32)
        .wrap(WrapMode::None);
        {
            let inbox = inbox.clone();
            edit_button.on_click(move |cx, _| {
                inbox.post(cx.app(), Msg::Composer(ComposerAction::EditMessage));
            });
        }
        let header = flow(&text("", theme.muted)).wrap(WrapMode::Word);
        let body = flow(&text("", theme.text)).wrap(WrapMode::Word);
        message_box
            .add(&message_label)
            .add(&edit_button)
            .add(&header)
            .add(&body);

        let info_box = View::new(app)
            .column()
            .absolute()
            .position(Edge::Left, 1u32)
            .width(Length::percent(97.0))
            .bg(color(theme.panel))
            .visible(false);
        let info_label = flow(&text("DETAILS", theme.accent))
            .height(1u32)
            .wrap(WrapMode::None);
        {
            let inbox = inbox.clone();
            info_label.on_click(move |cx, _| {
                inbox.post(cx.app(), Msg::Details(DetailsAction::CopySha));
            });
        }
        let info = text("", theme.text)
            .position(Edge::Left, details::COMMIT_INFO_LEFT as u32)
            .position(Edge::Top, details::COMMIT_INFO_TOP as u32);
        let (badge_left, badge_top, badge_width, badge_height) = details::AUTHOR_BADGE;
        let badge = text("", theme.author)
            .absolute()
            .position(Edge::Left, cells(badge_left))
            .position(Edge::Top, cells(badge_top))
            .width(cells(badge_width))
            .height(cells(badge_height))
            .wrap(WrapMode::None);
        let (photo_left, photo_top, photo_width, photo_height) = details::AUTHOR_PHOTO;
        let photo = ImageView::new(app)
            .absolute()
            .position(Edge::Left, cells(photo_left))
            .position(Edge::Top, cells(photo_top))
            .width(cells(photo_width))
            .height(cells(photo_height))
            .fit(ImageFit::Cover)
            .visible(false);
        let co_authors = text("", theme.muted)
            .absolute()
            .height(1u32)
            .wrap(WrapMode::Word);
        info_box
            .add(&info_label)
            .add(&photo)
            .add(&badge)
            .add(&co_authors)
            .add(&info);

        let history_label = text("", theme.muted)
            .absolute()
            .position(Edge::Left, 1u32)
            .width(Length::percent(97.0))
            .height(1u32)
            .wrap(WrapMode::None)
            .visible(false);
        let mut list = FileHistoryList::new(theme.clone());
        {
            let inbox = inbox.clone();
            list.on_event(move |cx, event| {
                let msg = match event {
                    FileHistoryEvent::Click(index) => Msg::FileHistoryClick(index),
                    FileHistoryEvent::Wheel(_) => return,
                };
                inbox.post(cx.app(), msg);
            });
        }
        let history_list = Custom::new(app, list)
            .absolute()
            .position(Edge::Left, 1u32)
            .width(Length::percent(97.0))
            .visible(false);
        Self {
            theme: theme.clone(),
            banner,
            message_box,
            message_label,
            edit_button,
            header,
            body,
            info_box,
            info_label,
            info,
            photo,
            badge,
            co_authors,
            history_label,
            history_list,
        }
    }

    /// Adds the widgets to the details pane. Call once.
    pub fn attach(&self, pane: &View) {
        pane.add(&self.info_box)
            .add(&self.banner)
            .add(&self.message_box)
            .add(&self.history_label)
            .add(&self.history_list);
    }

    #[cfg(test)]
    pub fn photo_shown(&self) -> bool {
        self.photo.is_visible() && !self.badge.is_visible()
    }

    /// Shows the author photo in place of the initials badge, or the badge again for `None`.
    pub fn set_photo(&self, image: Option<&Image>) {
        self.photo.image(image.cloned()).visible(image.is_some());
        self.badge.visible(image.is_none());
    }

    pub fn hide(&self) {
        self.banner.visible(false);
        self.message_box.visible(false);
        self.info_box.visible(false);
        self.history_label.visible(false);
        self.history_list.visible(false);
    }

    pub fn show(&self, input: &DetailsInput<'_>) {
        let theme = &self.theme;
        let width = input.pane_width.max(1);
        let CommitLayout {
            text,
            co_authors,
            banner_rows,
            mut layout,
            ..
        } = commit_layout(
            input.commit,
            input.working_files,
            width,
            input.history.is_some(),
        );
        let co_author_text = co_author_content(theme, &co_authors);
        let split = input
            .history
            .map(|_| file_history_split(input.content_height));
        if let Some(split) = split {
            // A file history gives the details a fixed share of the height, so the list stays under the pointer.
            layout.message_box_top = split.message_box_top;
            layout.message_box_height = split.message_box_height;
            layout.info_box_top = split.info_box_top;
            layout.info_box_height = split.info_box_height;
        }

        let banner_lines = working_changes_banner_lines(input.working_files, (width - 2).max(1));
        self.banner
            .visible(banner_rows > 0)
            .height(cells(banner_rows))
            .set_text(banner_lines.join("\n"));

        self.message_box
            .visible(true)
            .position(Edge::Top, cells(layout.message_box_top))
            .height(cells(layout.message_box_height));
        self.header
            .position(Edge::Top, cells(details::COMMIT_HEADER_TOP))
            .height(cells(layout.header_height))
            .set_text(text.header.clone());
        self.body
            .position(Edge::Top, cells(layout.body_top))
            .height(cells(layout.body_height))
            .set_text(text.body.clone());
        self.edit_button
            .visible(split.is_none())
            .position(Edge::Left, cells(layout.edit_message_left));
        self.message_label.set_text("COMMIT MESSAGE");

        self.info_box
            .visible(true)
            .position(Edge::Top, cells(layout.info_box_top))
            .height(cells(layout.info_box_height));
        self.info
            .width(cells(layout.info_width))
            .height(cells(layout.info_height))
            .set_text(info_content(theme, &text));
        self.badge.set_text(boxed_author_avatar(
            &input.commit.author,
            &input.commit.author_email,
        ));
        self.co_authors
            .visible(!co_authors.is_empty())
            .position(Edge::Left, cells(layout.co_authors_left))
            .position(Edge::Top, cells(layout.co_authors_top))
            .width(cells(layout.co_authors_width))
            .set_text(co_author_text);
        self.info_label
            .width(cells(layout.label_width))
            .set_text(label_text(&input.commit.sha, layout.label_width));

        match (input.history, split) {
            (Some(history), Some(split)) => {
                let kind = if history.line.is_some() {
                    "Line"
                } else {
                    "File"
                };
                self.history_label
                    .visible(true)
                    .position(Edge::Top, cells(split.unstaged_label_top))
                    .set_text(format!(" {kind} history · Esc to close "));
                self.history_list
                    .visible(true)
                    .position(Edge::Top, cells(split.unstaged_text_top))
                    .height(cells(split.unstaged_text_height));
                let (commits, index, start) =
                    (history.commits.clone(), history.index, history.start);
                self.history_list.update(|list| {
                    list.set_commits(commits);
                    list.set_selected(index, start);
                });
            }
            _ => {
                self.history_label.visible(false);
                self.history_list.visible(false);
            }
        }
    }
}

/// What the commit card shows and where it puts things, for a pane `width` columns wide.
struct CommitLayout {
    text: CommitText,
    co_authors: Vec<CoAuthor>,
    banner_rows: i64,
    layout: DetailsLayout,
}

/// Runs `layout_details` for `commit`. The details pane paints from it, and the files pane starts its commit file
/// list at `layout.files_top`.
fn commit_layout(
    commit: &Commit,
    working_files: usize,
    width: i64,
    with_history: bool,
) -> CommitLayout {
    let text = present_commit_text(commit);
    let co_authors = parse_co_authors(commit.body.as_deref().unwrap_or(""));
    let text_width = details_text_width(width);
    let banner_rows = if with_history {
        0
    } else {
        working_changes_banner_rows(working_files)
    };
    let layout = layout_details(DetailsInputs {
        details_pane_width: width,
        header_lines: wrapped_line_count(&text.header, text_width),
        body_lines: wrapped_line_count(&text.body, text_width),
        info_lines: wrapped_line_count(&text.info(), details_info_width(width)),
        co_authors_lines: (!co_authors.is_empty())
            .then(|| wrapped_line_count(&co_authors_plain(&co_authors), text_width)),
        co_authors_provider_visible: false,
        banner_rows,
    });
    CommitLayout {
        text,
        co_authors,
        banner_rows,
        layout,
    }
}

fn info_content(theme: &Theme, text: &CommitText) -> Vec<Span<'static>> {
    let mut spans = vec![text.author.clone().fg(color(theme.text))];
    if !text.muted.is_empty() {
        let muted: String = text.muted.iter().map(|line| format!("\n{line}")).collect();
        spans.push(muted.fg(color(theme.muted)));
    }
    spans
}

/// `Co-authors: [AB] Name  [CD] Other`. `presentCommitCoAuthors` without provider avatars.
fn co_author_content(theme: &Theme, authors: &[CoAuthor]) -> Vec<Span<'static>> {
    if authors.is_empty() {
        return Vec::new();
    }
    let mut spans = vec!["Co-authors: ".to_string().fg(color(theme.muted))];
    for (index, author) in authors.iter().enumerate() {
        spans.push(author_avatar(&author.name, &author.email).fg(color(theme.author)));
        spans.push(format!(" {}", author.name).fg(color(theme.text)));
        if index + 1 < authors.len() {
            spans.push("  ".to_string().fg(color(theme.muted)));
        }
    }
    spans
}

fn co_authors_plain(authors: &[CoAuthor]) -> String {
    if authors.is_empty() {
        return String::new();
    }
    let names: Vec<String> = authors
        .iter()
        .map(|author| {
            format!(
                "{} {}",
                author_avatar(&author.name, &author.email),
                author.name
            )
        })
        .collect();
    format!("Co-authors: {}", names.join("  "))
}

/// `DETAILS` and the short SHA at the right edge of the card.
fn label_text(sha: &str, label_width: i64) -> String {
    let short = short_sha(sha);
    let sha_columns = (!short.is_empty()).then(|| string_width(short) as i64);
    let gap = details_label_gap(label_width, string_width("DETAILS") as i64, sha_columns);
    let line = format!("DETAILS{}{short}", " ".repeat(gap as usize));
    fit_columns(&line, label_width, false)
}

impl Shell {
    fn has_working_files(&self) -> usize {
        self.snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.files.len())
    }

    /// The commit view is open: TS `view === "commit"`. The files pane owns the flag, so the two panes cannot
    /// disagree about it.
    pub fn commit_open(&self) -> bool {
        self.files.contents == Contents::Commit
    }

    /// The commit the pane shows: the open history's selection, else the selected history row, while the pane is
    /// open.
    pub fn details_commit(&self) -> Option<&Commit> {
        if !self.commit_open() {
            return None;
        }
        match &self.details.file_history {
            Some(history) => history.selected_commit(),
            None => self.selected_commit(),
        }
    }

    /// The commit selected in the history graph.
    pub fn selected_commit(&self) -> Option<&Commit> {
        let index = self.history.selection.commit()?;
        self.history.commits.get(index)
    }

    /// Row where the commit card ends, from the top of the details pane (`DetailsLayout::files_top`). The files
    /// pane starts its commit file list there. Only the commit view reads it, so it is 0 without a commit.
    pub(crate) fn details_files_top(&self) -> i64 {
        let Some(commit) = self.details_commit() else {
            return 0;
        };
        commit_layout(
            commit,
            self.has_working_files(),
            self.layout.panes.details_width.max(1),
            self.details.file_history.is_some(),
        )
        .layout
        .files_top
    }

    /// Ports `openCommit`. The files pane loads the commit's files when it sees the new view.
    pub fn open_commit(&mut self) {
        if self.selected_commit().is_none() {
            return;
        }
        self.files.contents = Contents::Commit;
        self.dirty |= Dirty::DETAILS | Dirty::FILES;
    }

    /// Ports `closeDiff` for a commit view: back to the working changes with the working row selected.
    pub fn close_commit(&mut self) {
        self.files.contents = Contents::Working;
        self.history.selection = HistorySelection::Working;
        self.history.viewport.detached = false;
        self.dirty |= Dirty::DETAILS | Dirty::FILES | Dirty::HISTORY;
    }

    /// The history selection moved onto the working row: `closeDiff` already ran in TS, so the pane leaves the
    /// commit view and the selection stays on the working row.
    pub(crate) fn close_details_for_working(&mut self) {
        self.clear_file_history();
        self.files.contents = Contents::Working;
        self.dirty |= Dirty::DETAILS | Dirty::FILES;
    }

    /// Ports the Escape step for the commit view. Returns false when it had nothing to close.
    pub fn escape_details(&mut self) -> bool {
        if self.clear_file_history() {
            return true;
        }
        if self.commit_open() {
            self.close_commit();
            return true;
        }
        false
    }

    pub(crate) fn details_action(&mut self, app: &App, action: DetailsAction) {
        match action {
            DetailsAction::CopySha => {
                let Some(sha) = self.selected_commit().map(|commit| commit.sha.clone()) else {
                    return;
                };
                if app.copy_to_clipboard(&sha) {
                    self.notice = Some(format!("Copied {}", short_sha(&sha)));
                }
            }
            DetailsAction::ViewWorking => self.close_commit(),
        }
    }

    #[allow(dead_code)] // Called from the graph menu and the files pane once those are ported.
    /// Ports `showFile`. `start` is the commit to start from, or HEAD.
    pub fn show_file_history(&mut self, app: &App, file: ChangedFile, start: Option<String>) {
        self.notice = Some(format!("Loading history for {}…", file.path));
        let repo = self.repo.clone();
        self.spawn(
            app,
            |tasks| &mut tasks.file_history,
            async move {
                let result = repo.file_history(&file.path, start.as_deref()).await;
                HistoryLoaded {
                    file,
                    line: None,
                    result,
                }
            },
            Msg::FileHistory,
        );
    }

    #[allow(dead_code)] // Called from the graph menu and the files pane once those are ported.
    /// Ports `showLine`.
    pub fn show_line_history(
        &mut self,
        app: &App,
        file: ChangedFile,
        line: usize,
        start: Option<String>,
    ) {
        self.notice = Some(format!("Loading history for {}:{line}…", file.path));
        let repo = self.repo.clone();
        self.spawn(
            app,
            |tasks| &mut tasks.file_history,
            async move {
                let result = repo.line_history(&file.path, line, start.as_deref()).await;
                HistoryLoaded {
                    file,
                    line: Some(line),
                    result,
                }
            },
            Msg::FileHistory,
        );
    }

    #[allow(dead_code)] // Called from the graph menu and the files pane once those are ported.
    /// Ports `showBlame`: finds the commit for one line and reports it in the footer.
    pub fn blame_line(&mut self, app: &App, path: String, line: usize, commit: Option<String>) {
        let repo = self.repo.clone();
        self.spawn(
            app,
            |tasks| &mut tasks.blame,
            async move { repo.blame_line(&path, line, commit.as_deref()).await },
            Msg::Blame,
        );
    }

    pub(crate) fn blame_loaded(&mut self, result: GitResult<LineBlame>) {
        self.notice = Some(match result {
            Ok(blame) => format!(
                "{} · {} · {}",
                short_sha(&blame.commit.sha),
                blame.commit.author,
                blame.commit.subject
            ),
            Err(error) => error.to_string(),
        });
    }

    pub(crate) fn file_history_loaded(&mut self, loaded: HistoryLoaded) {
        let commits = match loaded.result {
            Ok(commits) => commits,
            Err(error) => {
                self.notice = Some(error.to_string());
                return;
            }
        };
        if self.snapshot.is_none() {
            return;
        }
        self.notice = commits
            .is_empty()
            .then(|| format!("No history found for {}", loaded.file.path));
        self.details.file_history = Some(FileHistory {
            file: loaded.file,
            commits: commits.into(),
            index: 0,
            start: 0,
            line: loaded.line,
        });
        self.files.contents = Contents::Commit;
        self.dirty |= Dirty::DETAILS | Dirty::FILES;
    }

    /// Ports `clear`. Returns false when no history was open. The pane keeps the selected history commit.
    pub fn clear_file_history(&mut self) -> bool {
        self.tasks.file_history.cancel();
        let was_open = self.details.file_history.take().is_some();
        if was_open {
            self.dirty |= Dirty::DETAILS;
        }
        was_open
    }

    /// Cards the list shows at once.
    fn file_history_viewport(&self) -> usize {
        let split = file_history_split(self.content_height());
        usize::try_from(split.unstaged_text_height)
            .unwrap_or(1)
            .max(CARD_ROWS as usize)
            / CARD_ROWS as usize
    }

    fn content_height(&self) -> i64 {
        (i64::from(self.layout.height) - i64::from(PANE_TOP)).max(1)
    }

    /// Ports `scroll`: moves the selection by `delta` commits. Returns false when no history is open.
    pub fn scroll_file_history(&mut self, delta: i64) -> bool {
        let viewport = self.file_history_viewport();
        let Some(history) = self.details.file_history.as_mut() else {
            return false;
        };
        let max = history.commits.len().saturating_sub(1) as i64;
        history.index = (history.index as i64 + delta).clamp(0, max) as usize;
        if history.index < history.start {
            history.start = history.index;
        } else if history.index >= history.start + viewport {
            history.start = history.index + 1 - viewport;
        }
        self.dirty |= Dirty::DETAILS;
        true
    }

    /// Ports `click` for a card.
    pub(crate) fn select_file_history(&mut self, index: usize) {
        if let Some(history) = self.details.file_history.as_mut()
            && index < history.commits.len()
        {
            history.index = index;
            self.dirty |= Dirty::DETAILS;
        }
    }

    pub(crate) fn sync_details(&mut self) {
        // The composer takes the pane while a commit message is edited.
        let commit = self
            .details_commit()
            .cloned()
            .filter(|_| !self.composer.editing());
        let Some(commit) = commit else {
            self.widgets.details_view.hide();
            return;
        };
        self.widgets.details_view.show(&DetailsInput {
            commit: &commit,
            working_files: self.has_working_files(),
            pane_width: self.layout.panes.details_width,
            content_height: self.content_height(),
            history: self.details.file_history.as_ref(),
        });
    }
}

#[cfg(test)]
#[path = "details_tests.rs"]
mod tests;
