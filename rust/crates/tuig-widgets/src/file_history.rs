//! The file and line history list: one four-row card per commit. Ports `RuntimeFileHistoryController.paint` in
//! `src/ui/runtime-file-history.ts`.
//!
//! The shell owns the commits, the selected index and the first visible card. This widget paints them and reports
//! clicks and wheel notches as [`FileHistoryEvent`] through [`FileHistoryList::on_event`].

use crate::commit_text::{
    author_avatar, clip_columns, format_commit_date, format_relative_time, short_sha,
};
use jiff::Timestamp;
use opentui::prelude::*;
use std::rc::Rc;
use tuig_git::types::Commit;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::text_width::string_width;
use tuig_ui_model::theme::Theme;

/// Terminal rows one commit card takes. `FILE_HISTORY_CARD_ROWS`.
pub const CARD_ROWS: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileHistoryEvent {
    /// A left press on a card. The index counts from the first commit, not from the first visible card.
    Click(usize),
    /// Wheel notches, negative up. The TS app does not handle the wheel here, so the shell may ignore it.
    Wheel(i32),
}

type EventHandler = Box<dyn FnMut(&mut Cx<'_>, FileHistoryEvent)>;

pub struct FileHistoryList {
    theme: Theme,
    commits: Rc<[Commit]>,
    selected: usize,
    start: usize,
    now: Timestamp,
    on_event: Option<EventHandler>,
}

fn color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

impl FileHistoryList {
    pub fn new(theme: Theme) -> Self {
        Self {
            theme,
            commits: Rc::default(),
            selected: 0,
            start: 0,
            now: Timestamp::now(),
            on_event: None,
        }
    }

    pub fn set_commits(&mut self, commits: Rc<[Commit]>) {
        self.commits = commits;
        self.now = Timestamp::now();
    }

    pub fn set_selected(&mut self, selected: usize, start: usize) {
        self.selected = selected;
        self.start = start;
    }

    pub fn set_theme(&mut self, theme: &Theme) {
        self.theme = theme.clone();
    }

    /// The handler must queue a message and not call `Custom::update` on this widget.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, FileHistoryEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    /// The four lines of one card, each as text plus its foreground. The first two lines are clipped to the card.
    fn card(&self, commit: &Commit, selected: bool, width: i64) -> [(String, Rgba); 3] {
        let theme = &self.theme;
        let inner = (width - 2).max(1);
        let marker = if selected { "›" } else { " " };
        let subject = clip_columns(&commit.subject, inner);
        let identity = clip_columns(
            &format!(
                "{} {} · {}",
                author_avatar(&commit.author, &commit.author_email),
                commit.author,
                short_sha(&commit.sha)
            ),
            inner,
        );
        let metadata = clip_columns(
            &format!(
                "{} · {}",
                format_relative_time(&commit.committed_at, self.now),
                format_commit_date(&commit.committed_at)
            ),
            inner,
        );
        [
            (format!("{marker} {subject}"), theme.text),
            (
                format!("  {identity}"),
                if selected { theme.accent } else { theme.author },
            ),
            (format!("  {metadata}"), theme.muted),
        ]
    }

    /// The commit under widget row `row`.
    fn commit_at(&self, row: i32) -> Option<usize> {
        let card = usize::try_from(row).ok()? / CARD_ROWS as usize;
        let index = self.start + card;
        (index < self.commits.len()).then_some(index)
    }

    fn emit(&mut self, cx: &mut Cx<'_>, event: FileHistoryEvent) {
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, event);
        }
    }
}

impl Component for FileHistoryList {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        painter.fill(0, 0, width, height, color(self.theme.panel));
        let cards = (height / CARD_ROWS).max(1) as usize;
        for (offset, commit) in self.commits.iter().skip(self.start).take(cards).enumerate() {
            let selected = self.start + offset == self.selected;
            let background = color(if selected {
                self.theme.selected
            } else {
                self.theme.panel
            });
            let top = (offset as u32 * CARD_ROWS) as i32;
            for (line, (text, fg)) in self
                .card(commit, selected, i64::from(width))
                .iter()
                .enumerate()
            {
                let y = top + line as i32;
                painter.fill(0, y, width, 1, background);
                let clipped = if string_width(text) > width as usize {
                    clip_columns(text, i64::from(width))
                } else {
                    text.clone()
                };
                painter.text(0, y, &clipped, Style::new().fg(color(*fg)).bg(background));
            }
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        let event = match event.kind {
            MouseEventKind::ScrollUp => FileHistoryEvent::Wheel(-1),
            MouseEventKind::ScrollDown => FileHistoryEvent::Wheel(1),
            MouseEventKind::Down(MouseButton::Left) => {
                let Some(index) = self.commit_at(local.1) else {
                    return false;
                };
                FileHistoryEvent::Click(index)
            }
            _ => return false,
        };
        self.emit(cx, event);
        true
    }
}
