//! The commit composer. Ports the composer widgets in `src/ui/runtime-widgets.ts`, `composerKey` in
//! `src/ui/runtime-keys.ts`, `commit`, `toggleAmend`, `editMessage` and `cancelEditMessage` in
//! `src/ui/runtime-commands.ts`, and `paintComposer` in `src/ui/runtime-paint.ts`. The text, the button label and
//! the amend and edit state are in `tuig_ui_model::composer`. The pane geometry comes from `layout_changes`, through
//! `Shell::composer_place`.
//!
//! The summary and the description are OpenTUI `Input` and `Textarea` widgets. They own their text. The shell reads
//! it when it commits or paints the button. While one of them has focus, the shell passes every key to it and takes
//! only Tab (switch field) and Escape (leave the composer).
//!
//! A commit, an amend and a message save run in the mutation slot, like staging. The mutation result hook is
//! [`Shell::composer_mutation_done`].
//!
//! Gaps against the TS app:
//!
//! - The command palette entry "Compose commit" does not exist yet. [`Shell::focus_composer`] is its entry point.
//! - Hover and press colors on the two buttons (`tuig_widgets::composer`).
//! - TS also leaves the composer when a repository tab closes (`runtime-tabs.ts`). A tab switch resets the composer (`switch_repository` in `header.rs`).
//! - An Escape that cancels a running mutation (`cancelMutation`) is not ported.

use crate::screens::footer::NoticeTone;
use crate::shell::{Dirty, Inbox, Msg, Shell};
use crate::sync::place;
use opentui::prelude::*;
use opentui::widget::{Input, Text, Textarea, View};
use std::rc::Rc;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::composer::{
    ComposerModel, Draft, NoPreviousCommit, amend_label, commit_button, commit_message,
};
use tuig_ui_model::runtime_layout::ComposerLayout;
use tuig_ui_model::theme::{Surface, Theme, ThemeStates, semantic_color};
use tuig_widgets::composer::{ButtonVariant, ComposerButton};
use tuig_widgets::decorations::resolve_head_sha;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerAction {
    /// The commit button, or Enter in the summary.
    Commit,
    ToggleAmend,
    /// The "Edit Message" button of the commit card.
    EditMessage,
    /// The summary text changed, so the commit button label may change.
    Edited,
}

#[derive(Default)]
pub struct ComposerState {
    pub model: ComposerModel,
    /// Set while a commit, amend or message save runs. The value is whether it saves a message.
    pending: Option<bool>,
    /// Focus the summary once the composer is visible. TS does it with `setTimeout(..., 0)`.
    focus_summary: bool,
    /// Whether a field had focus after the last message, to retry a refresh held back while typing.
    was_composing: bool,
}

impl ComposerState {
    pub fn editing(&self) -> bool {
        self.model.editing.is_some()
    }
}

fn color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

/// The form field colors of `updateWidgetTheme`: base, focused, and cursor.
struct FieldColors {
    fg: Rgba,
    bg: Rgba,
    focused_fg: Rgba,
    focused_bg: Rgba,
    cursor: Rgba,
    placeholder: Rgba,
}

fn field_colors(theme: &Theme) -> FieldColors {
    let pick = |path: &str, fallback: Rgba, focused: bool| {
        let states = ThemeStates {
            focused,
            ..ThemeStates::default()
        };
        semantic_color(theme, path, fallback, Surface::Default, states)
    };
    FieldColors {
        fg: pick("text.formfield", theme.text, false),
        bg: pick("background.formfield", theme.panel_raised, false),
        focused_fg: pick("text.formfield", theme.text, true),
        focused_bg: pick("background.formfield", theme.selected, true),
        cursor: pick("text.formfield", theme.focus_ring, true),
        placeholder: pick("text.muted", theme.muted, false),
    }
}

pub struct ComposerWidgets {
    frame: View,
    label: Text,
    pub summary: Input,
    pub body: Textarea,
    amend: Custom<ComposerButton>,
    commit: Custom<ComposerButton>,
}

/// Keeps Tab from moving OpenTUI's focus, and keeps Ctrl+C from quitting while a field has focus. TS swallows both.
#[derive(Clone)]
pub struct KeyGuard {
    summary: Input,
    body: Textarea,
}

impl KeyGuard {
    pub fn apply(&self, cx: &mut Cx<'_>, key: &KeyEvent) {
        let composing = self.summary.is_focused() || self.body.is_focused();
        if key.matches("tab") || key.matches("shift+tab") || (composing && key.matches("ctrl+c")) {
            cx.prevent_default();
        }
    }
}

impl ComposerWidgets {
    pub fn new(app: &App, theme: &Theme, inbox: &Rc<Inbox>) -> Self {
        let colors = field_colors(theme);
        let frame = View::new(app)
            .absolute()
            .position(Edge::Left, 1u32)
            .bg(color(theme.panel))
            .visible(false);
        let label = Text::new(app, " COMMIT MESSAGE")
            .fg(color(theme.accent))
            .absolute()
            .position(Edge::Left, 0u32)
            .position(Edge::Top, 0u32)
            .height(1u32)
            .wrap(WrapMode::None);
        let summary = Input::new(app)
            .placeholder("Summary")
            .placeholder_color(color(colors.placeholder))
            .colors(color(colors.fg), color(colors.bg))
            .focused_colors(color(colors.focused_fg), color(colors.focused_bg))
            .cursor_color(color(colors.cursor))
            .absolute()
            .position(Edge::Left, 1u32)
            .position(Edge::Top, 1u32)
            .height(1u32);
        let body = Textarea::new(app)
            .placeholder("Description")
            .placeholder_color(color(colors.placeholder))
            .colors(color(colors.fg), color(colors.bg))
            .focused_colors(color(colors.focused_fg), color(colors.focused_bg))
            .cursor_color(color(colors.cursor))
            .wrap(WrapMode::Word)
            .absolute()
            .position(Edge::Left, 1u32);
        {
            let inbox = inbox.clone();
            summary.on_change(move |cx, _| {
                inbox.post(cx.app(), Msg::Composer(ComposerAction::Edited));
            });
        }
        {
            let inbox = inbox.clone();
            summary.on_submit(move |cx, _| {
                inbox.post(cx.app(), Msg::Composer(ComposerAction::Commit));
            });
        }
        let button = |action: ComposerAction, variant: ButtonVariant, fg: Rgba, bg: Rgba| {
            let mut button = ComposerButton::new(theme.clone(), variant, fg, bg);
            let inbox = inbox.clone();
            button.on_press(move |cx| inbox.post(cx.app(), Msg::Composer(action)));
            let hovered = button.hover_flag();
            Custom::new(app, button)
                .absolute()
                .position(Edge::Left, 1u32)
                .height(1u32)
                .on_hover(move |cx, over| {
                    hovered.set(over);
                    cx.app().request_redraw();
                })
        };
        let amend = button(
            ComposerAction::ToggleAmend,
            ButtonVariant::Secondary,
            theme.muted,
            Rgba::TRANSPARENT,
        );
        let commit = button(
            ComposerAction::Commit,
            ButtonVariant::Primary,
            theme.added,
            theme.panel_raised,
        );
        frame
            .add(&label)
            .add(&summary)
            .add(&body)
            .add(&amend)
            .add(&commit);
        Self {
            frame,
            label,
            summary,
            body,
            amend,
            commit,
        }
    }

    /// Puts the composer into the details pane.
    pub fn attach(&self, details: &View) {
        details.add(&self.frame);
    }

    pub fn key_guard(&self) -> KeyGuard {
        KeyGuard {
            summary: self.summary.clone(),
            body: self.body.clone(),
        }
    }

    pub fn composing(&self) -> bool {
        self.summary.is_focused() || self.body.is_focused()
    }

    fn draft(&self) -> Draft {
        Draft::new(self.summary.value(), self.body.text())
    }

    fn set_draft(&self, draft: &Draft) {
        self.summary.set_value(&draft.summary);
        self.body.set_text(&draft.body);
    }

    /// Places the children of the frame, which `layout` positions relative to the details pane.
    fn place(&self, layout: &ComposerLayout) {
        let children = layout.children;
        let width = layout.field_width;
        self.frame.visible(layout.visible);
        place(&self.frame, 1, layout.top, layout.box_width, layout.height);
        self.label.width(cells(layout.box_width));
        self.summary
            .visible(children.summary_visible)
            .width(cells(width));
        self.body
            .visible(children.body_visible)
            .position(Edge::Top, cells(children.body_top))
            .width(cells(width))
            .height(cells(children.body_height));
        self.amend
            .visible(children.amend_visible)
            .position(Edge::Top, cells(children.amend_top))
            .width(cells(width));
        self.commit
            .visible(children.commit_visible)
            .position(Edge::Top, cells(children.commit_top))
            .width(cells(width));
    }

    fn paint_buttons(&self, model: &ComposerModel, staged: usize, pane_width: i64) {
        let button = commit_button(
            model.editing.is_some(),
            staged,
            &self.summary.value(),
            pane_width,
        );
        let disabled = !button.ready;
        self.commit
            .update(|commit| commit.set(&button.text, false, disabled));
        let label = amend_label(model.amend);
        self.amend
            .update(|amend| amend.set(&label, model.amend, false));
    }
}

fn cells(value: i64) -> u32 {
    u32::try_from(value.max(0)).unwrap_or(0)
}

impl Shell {
    /// A commit field has focus.
    pub fn composing(&self) -> bool {
        self.widgets.composer.composing()
    }

    pub(crate) fn composer_action(&mut self, app: &App, action: ComposerAction) {
        match action {
            ComposerAction::Commit => self.commit(app),
            ComposerAction::ToggleAmend => self.toggle_amend(),
            ComposerAction::EditMessage => self.edit_message(),
            ComposerAction::Edited => self.dirty |= Dirty::COMPOSER,
        }
    }

    /// Entry point for the `c` key and the "Compose commit" palette entry.
    pub fn focus_composer(&mut self) {
        self.composer.focus_summary = true;
        self.dirty |= Dirty::COMPOSER;
    }

    fn set_draft(&mut self, draft: &Draft) {
        self.widgets.composer.set_draft(draft);
        self.dirty |= Dirty::COMPOSER;
    }

    /// The message of the commit HEAD points at, for the amend toggle.
    fn head_draft(&self) -> Option<Draft> {
        let snapshot = self.snapshot.as_ref()?;
        let sha = resolve_head_sha(&snapshot.branches, &self.history.commits)?;
        let head = self
            .history
            .commits
            .iter()
            .find(|commit| commit.sha == sha)?;
        Some(Draft::new(
            head.subject.clone(),
            head.body.clone().unwrap_or_default(),
        ))
    }

    fn toggle_amend(&mut self) {
        let current = self.widgets.composer.draft();
        let head = self.head_draft();
        match self.composer.model.toggle_amend(current, head) {
            Ok(Some(draft)) => self.set_draft(&draft),
            Ok(None) => self.dirty |= Dirty::COMPOSER,
            Err(NoPreviousCommit) => {
                self.notice = Some("No previous commit to amend".to_owned());
            }
        }
    }

    /// Ports `editMessage`: the composer shows the selected commit's message, in place of the commit card.
    pub fn edit_message(&mut self) {
        let Some(commit) = self.selected_commit() else {
            return;
        };
        let sha = commit.sha.clone();
        let message = Draft::new(
            commit.subject.clone(),
            commit.body.clone().unwrap_or_default(),
        );
        let current = self.widgets.composer.draft();
        let shown = self.composer.model.start_edit(current, &sha, message);
        self.set_draft(&shown);
        self.composer.focus_summary = true;
        self.dirty |= Dirty::LAYOUT | Dirty::FILES | Dirty::DETAILS;
    }

    fn cancel_edit_message(&mut self, app: &App) {
        app.blur();
        if let Some(draft) = self.composer.model.cancel_edit() {
            self.set_draft(&draft);
        }
        self.dirty |= Dirty::LAYOUT | Dirty::FILES | Dirty::DETAILS;
    }

    /// Ports `commit`: a commit, an amend, or the save of an edited message.
    fn commit(&mut self, app: &App) {
        let draft = self.widgets.composer.draft();
        let Some(message) = commit_message(&draft.summary, &draft.body) else {
            self.notice = Some("Commit summary cannot be empty".to_owned());
            return;
        };
        let reword = self.composer.model.editing.clone();
        if reword.is_none() && self.files.staged_count() == 0 {
            self.notice = Some("Nothing staged to commit".to_owned());
            return;
        }
        let amend = self.composer.model.amend;
        let label = match (&reword, amend) {
            (Some(_), _) => "Saving commit message",
            (None, true) => "Amending commit",
            (None, false) => "Committing",
        };
        if let Some(running) = &self.diff.mutation {
            self.notice = Some(format!("{running} is still running"));
            return;
        }
        app.blur();
        self.composer.pending = Some(reword.is_some());
        let saves = reword.is_some();
        let repo = self.repo.clone();
        self.perform(app, label, async move {
            match reword {
                Some(sha) => repo.reword_commit(&sha, &message).await,
                None if amend => repo.amend_commit(&message).await,
                None => repo.commit(&message).await,
            }
        });
        self.notify_tone(
            NoticeTone::Busy,
            if saves {
                "Saving message…"
            } else {
                "Committing…"
            },
        );
        self.dirty |= Dirty::COMPOSER;
    }

    /// Runs when any mutation finishes. A commit, amend or message save also resets the composer.
    pub(crate) fn composer_mutation_done(&mut self, ok: bool) {
        let Some(reword) = self.composer.pending.take() else {
            return;
        };
        if ok {
            if let Some(draft) = self.composer.model.committed() {
                self.set_draft(&draft);
            }
            self.dirty |= Dirty::COMPOSER | Dirty::LAYOUT | Dirty::FILES | Dirty::DETAILS;
        } else if reword {
            // The edit stays open, so the user can fix the message.
            self.composer.focus_summary = true;
            self.dirty |= Dirty::COMPOSER;
        }
    }

    /// Ports `composerKey`. Returns true when the composer took the key.
    pub(crate) fn composer_key(&mut self, key: &KeyEvent) -> bool {
        let widgets = &self.widgets.composer;
        let (in_summary, in_body) = (widgets.summary.is_focused(), widgets.body.is_focused());
        if !(in_summary || in_body) || key.matches("escape") || key.matches("esc") {
            return false;
        }
        let is_press = key.kind != opentui::input::KeyEventKind::Release;
        if is_press && (key.matches("tab") || key.matches("shift+tab")) {
            if in_summary {
                widgets.body.focus();
            } else {
                widgets.summary.focus();
            }
        }
        true
    }

    /// The composer's step of Escape: leave an edited message, or give up the keyboard. Returns false when the
    /// composer had nothing to do. A selected diff line comes first when the user is not editing a message, as in TS.
    pub(crate) fn composer_escape(&mut self, app: &App) -> bool {
        if self.composer.editing() {
            self.cancel_edit_message(app);
            return true;
        }
        if self.composing() && self.diff.selected_rows.is_empty() {
            app.blur();
            self.dirty |= Dirty::COMPOSER;
            return true;
        }
        false
    }

    /// Where the composer sits in the details pane, or `None` when it is hidden.
    pub(crate) fn composer_visible_place(&self) -> Option<ComposerLayout> {
        if !self.layout.panes.details_visible {
            return None;
        }
        self.composer_place()
    }

    pub(crate) fn sync_composer(&mut self) {
        if !self
            .dirty
            .intersects(Dirty::COMPOSER | Dirty::LAYOUT | Dirty::FILES | Dirty::DETAILS)
        {
            return;
        }
        let widgets = &self.widgets.composer;
        match self.composer_visible_place() {
            Some(layout) => {
                widgets.place(&layout);
                widgets.paint_buttons(
                    &self.composer.model,
                    self.files.staged_count(),
                    self.layout.panes.details_width,
                );
            }
            None => {
                widgets.frame.visible(false);
            }
        }
        if std::mem::take(&mut self.composer.focus_summary) {
            widgets.summary.focus();
        }
    }

    /// Runs after each message. When the user leaves the composer, a refresh that waited for it starts.
    pub(crate) fn settle_composer(&mut self, app: &App) {
        let composing = self.composing();
        if std::mem::replace(&mut self.composer.was_composing, composing) && !composing {
            self.retry_held_refresh(app);
        }
    }
}

#[cfg(test)]
#[path = "composer_tests.rs"]
mod tests;
