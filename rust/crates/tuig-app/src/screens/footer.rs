//! The bottom row. Ports `RuntimeNotificationsController` in `src/ui/runtime-notifications.ts` and `paintHints` in
//! `src/ui/runtime.ts`.
//!
//! Screens set [`Shell::notice`] to show a message. [`Shell::sync_footer`] sees the change, paints it at the right of
//! the bottom row, and clears it after six seconds so the key hints at the left stay the resting state. A screen
//! that needs the error color calls [`Shell::notify_error`]. A busy message belongs in the toolbar in TS, so the footer
//! skips it. [`Shell::busy_notice`] returns it for the header.

use crate::shell::Msg;
use crate::shell::Shell;
use opentui::prelude::*;
use std::time::Duration;
use tuig_widgets::footer::{HintContext, HintFocus, HintView, MessageTone};

/// How long a message stays. `setTimeout` in `notify`.
const NOTICE_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeTone {
    Info,
    Error,
    /// Progress of a running operation. The toolbar shows it, not the footer.
    Busy,
}

#[derive(Default)]
pub struct FooterState {
    /// The notice the widget shows, to tell a new one from the one already on screen.
    shown: Option<String>,
    /// The tone of the notice with this text. A notice set by plain assignment has no entry, so it is `Info`.
    tone: Option<(NoticeTone, String)>,
    timer: Option<TimerId>,
    /// Counts the notices shown, so the same text shown again is a new notice.
    serial: u64,
    /// The serial of the notice on screen.
    shown_serial: u64,
    /// Bumped for every timer, so a message that was replaced ignores the old expiry.
    generation: u64,
    hints: HintContext,
}

impl Shell {
    pub(crate) fn notify_error(&mut self, text: impl Into<String>) {
        self.notify_tone(NoticeTone::Error, text);
    }

    pub(crate) fn notify_tone(&mut self, tone: NoticeTone, text: impl Into<String>) {
        let text = text.into();
        self.footer.tone = Some((tone, text.clone()));
        self.set_notice(text);
    }

    /// Shows `text` in the footer. A text that is already showing starts its six seconds again, as `notify` does in
    /// TS.
    pub(crate) fn set_notice(&mut self, text: String) {
        self.footer.serial += 1;
        self.notice = Some(text);
    }

    fn notice_tone(&self) -> NoticeTone {
        match (&self.footer.tone, &self.notice) {
            (Some((tone, text)), Some(notice)) if text == notice => *tone,
            _ => NoticeTone::Info,
        }
    }

    /// The text of a running operation, for the toolbar.
    pub(crate) fn busy_notice(&self) -> Option<&str> {
        (self.notice_tone() == NoticeTone::Busy)
            .then_some(self.notice.as_deref())
            .flatten()
    }

    fn hint_context(&self) -> HintContext {
        use crate::screens::files::Focus;
        let view = if self.diff.is_open() {
            if self.diff.working() {
                HintView::Working
            } else {
                HintView::Commit
            }
        } else if self.commit_open() {
            HintView::Commit
        } else {
            HintView::History
        };
        let selected = self.diff.selected_rows.len();
        HintContext {
            focus: match self.files.focus {
                Focus::History => HintFocus::History,
                Focus::Changes => HintFocus::Changes,
            },
            view,
            // The commit message editor reuses the composer fields, but TS keeps the pane hints while editing.
            composing: self.composing() && !self.composer.editing(),
            line_selection: (selected > 0).then(|| (selected, self.diff.staged())),
        }
    }

    /// Pushes the hints and the message into the footer widget, and starts or stops the expiry timer.
    pub(crate) fn sync_footer(&mut self, app: &App) {
        let hints = self.hint_context();
        if hints != self.footer.hints {
            self.footer.hints = hints;
            self.widgets
                .footer
                .update(|footer| footer.set_hints(&hints));
        }
        if self.notice == self.footer.shown
            && (self.notice.is_none() || self.footer.serial == self.footer.shown_serial)
        {
            return;
        }
        self.footer.shown = self.notice.clone();
        self.footer.shown_serial = self.footer.serial;
        if let Some(timer) = self.footer.timer.take() {
            app.cancel_timer(timer);
        }
        let tone = self.notice_tone();
        let (text, message_tone) = match (&self.notice, tone) {
            (Some(text), NoticeTone::Info) => (text.clone(), MessageTone::Info),
            (Some(text), NoticeTone::Error) => (text.clone(), MessageTone::Error),
            _ => (String::new(), MessageTone::Info),
        };
        self.widgets
            .footer
            .update(|footer| footer.set_message(&text, message_tone));
        if !text.is_empty() {
            self.footer.generation += 1;
            let generation = self.footer.generation;
            let inbox = self.inbox.clone();
            self.footer.timer = Some(app.set_timeout(NOTICE_TIMEOUT, move |cx| {
                inbox.post(cx.app(), Msg::NoticeExpired(generation));
            }));
        }
    }

    pub(crate) fn notice_expired(&mut self, generation: u64) {
        if generation != self.footer.generation {
            return;
        }
        self.footer.timer = None;
        self.notice = None;
    }
}

#[cfg(test)]
#[path = "footer_tests.rs"]
mod tests;
