//! The commit composer without widgets: the message text, the button label and the amend and edit-message state.
//! Ports `commit`, `toggleAmend`, `editMessage`, `cancelEditMessage` and `restoreEditReturnState` in
//! `src/ui/runtime-commands.ts`, and `paintComposer` in `src/ui/runtime-paint.ts`.
//!
//! The model owns no text. The shell passes the current fields in and puts the returned [`Draft`] into the fields.

use crate::text_width::{fit_columns, string_width};

/// The two composer fields.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Draft {
    pub summary: String,
    pub body: String,
}

impl Draft {
    pub fn new(summary: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            summary: summary.into(),
            body: body.into(),
        }
    }
}

/// The full message for a commit: the trimmed summary, a blank line, and the trimmed body when it has text.
/// `None` when the summary is empty.
pub fn commit_message(summary: &str, body: &str) -> Option<String> {
    let summary = summary.trim();
    if summary.is_empty() {
        return None;
    }
    let body = body.trim();
    Some(if body.is_empty() {
        summary.to_owned()
    } else {
        format!("{summary}\n\n{body}")
    })
}

/// What the commit button shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitButton {
    pub text: String,
    /// A click commits. Not set while the label asks for a summary or for staged files.
    pub ready: bool,
}

/// The commit button for `staged` staged files in a details pane `pane_width` columns wide. While a commit message is
/// edited the button saves it and never waits for staged files.
pub fn commit_button(editing: bool, staged: usize, summary: &str, pane_width: i64) -> CommitButton {
    if editing {
        return CommitButton {
            text: "Save message".to_owned(),
            ready: true,
        };
    }
    let ready = staged > 0 && !summary.trim().is_empty();
    let text = if ready {
        format!(
            "Commit {staged} staged file{}",
            if staged == 1 { "" } else { "s" }
        )
    } else if staged == 0 {
        "Stage files to commit".to_owned()
    } else {
        "Write a summary to commit".to_owned()
    };
    let width = 10.max(pane_width - 4);
    let padding = ((width - string_width(&text) as i64) / 2).max(0) as usize;
    let mark = if ready { "✓ " } else { "" };
    CommitButton {
        text: fit_columns(
            &format!("{}{mark}{text}", " ".repeat(padding)),
            width,
            false,
        ),
        ready,
    }
}

/// The amend toggle label.
pub fn amend_label(amend: bool) -> String {
    format!(
        "{} Amend previous commit",
        if amend { "[x]" } else { "[ ]" }
    )
}

/// What the composer was showing before a commit message edit began.
#[derive(Debug, Clone, PartialEq, Eq)]
struct EditReturn {
    draft: Draft,
    amend: bool,
    amend_draft: Option<Draft>,
}

/// There is no commit to amend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoPreviousCommit;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ComposerModel {
    pub amend: bool,
    /// The draft the amend toggle replaced with the last commit's message.
    amend_draft: Option<Draft>,
    /// The commit whose message the composer edits. `editingCommitSha`.
    pub editing: Option<String>,
    edit_return: Option<EditReturn>,
}

impl ComposerModel {
    /// Ports `toggleAmend`. Turning amend on saves `current` and returns the head commit's message for the fields.
    /// Turning it off returns the saved draft, or `None` when there is none, so the fields stay as they are.
    pub fn toggle_amend(
        &mut self,
        current: Draft,
        head: Option<Draft>,
    ) -> Result<Option<Draft>, NoPreviousCommit> {
        if self.amend {
            self.amend = false;
            return Ok(self.amend_draft.take());
        }
        let head = head.ok_or(NoPreviousCommit)?;
        self.amend_draft = Some(current);
        self.amend = true;
        Ok(Some(head))
    }

    /// Ports `editMessage`. Saves `current` with the amend state and returns the commit's message for the fields.
    pub fn start_edit(&mut self, current: Draft, sha: &str, message: Draft) -> Draft {
        self.edit_return = Some(EditReturn {
            draft: current,
            amend: self.amend,
            amend_draft: self.amend_draft.clone(),
        });
        self.editing = Some(sha.to_owned());
        message
    }

    /// Ports `cancelEditMessage`: returns the draft the edit replaced.
    pub fn cancel_edit(&mut self) -> Option<Draft> {
        self.editing = None;
        self.restore_edit_return()
    }

    /// The commit or the message save succeeded. Returns the fields' new content: the draft from before the edit
    /// after a message edit, else empty fields.
    pub fn committed(&mut self) -> Option<Draft> {
        if self.editing.take().is_some() {
            return self.restore_edit_return();
        }
        self.amend = false;
        self.amend_draft = None;
        Some(Draft::default())
    }

    /// Ports a tab switch's reset (`runtime-tabs.ts`): amend and edit state go, and the fields empty.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    fn restore_edit_return(&mut self) -> Option<Draft> {
        let state = self.edit_return.take()?;
        self.amend = state.amend;
        self.amend_draft = state.amend_draft;
        Some(state.draft)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(summary: &str, body: &str) -> Draft {
        Draft::new(summary, body)
    }

    #[test]
    fn the_message_joins_a_trimmed_body_after_a_blank_line() {
        assert_eq!(
            commit_message("  fix  ", "\n why \n"),
            Some("fix\n\nwhy".into())
        );
        assert_eq!(commit_message("fix", "  \n "), Some("fix".into()));
        assert_eq!(commit_message("  ", "body"), None);
    }

    #[test]
    fn the_button_asks_for_what_is_missing() {
        let text = |staged, summary| commit_button(false, staged, summary, 44);
        assert!(
            text(0, "x")
                .text
                .trim()
                .starts_with("Stage files to commit")
        );
        assert!(
            text(2, " ")
                .text
                .trim()
                .starts_with("Write a summary to commit")
        );
        let ready = text(1, "x");
        assert!(ready.ready);
        assert_eq!(ready.text.trim(), "✓ Commit 1 staged file");
        assert_eq!(string_width(&ready.text), 40);
        assert_eq!(text(3, "x").text.trim(), "✓ Commit 3 staged files");
        assert_eq!(commit_button(true, 0, "", 44).text, "Save message");
    }

    #[test]
    fn amend_swaps_in_the_last_message_and_gives_the_draft_back() {
        let mut model = ComposerModel::default();
        let shown = model
            .toggle_amend(draft("wip", "notes"), Some(draft("last", "body")))
            .unwrap();
        assert_eq!(shown, Some(draft("last", "body")));
        assert!(model.amend);
        // The user edits the amended text; turning amend off still restores the first draft.
        let restored = model.toggle_amend(draft("last!", "body"), None).unwrap();
        assert_eq!(restored, Some(draft("wip", "notes")));
        assert!(!model.amend);
        assert_eq!(
            model.toggle_amend(draft("", ""), None),
            Err(NoPreviousCommit)
        );
    }

    #[test]
    fn cancelling_a_message_edit_restores_the_draft_and_the_amend_state() {
        let mut model = ComposerModel::default();
        model
            .toggle_amend(draft("wip", ""), Some(draft("last", "")))
            .unwrap();
        let shown = model.start_edit(
            draft("last", "more"),
            "abc",
            draft("old subject", "old body"),
        );
        assert_eq!(shown, draft("old subject", "old body"));
        assert_eq!(model.editing.as_deref(), Some("abc"));
        assert_eq!(model.cancel_edit(), Some(draft("last", "more")));
        assert!(model.editing.is_none());
        assert!(model.amend, "amend survives the edit");
        // The saved amend draft survived too.
        assert_eq!(
            model.toggle_amend(draft("last", "more"), None).unwrap(),
            Some(draft("wip", ""))
        );
    }

    #[test]
    fn a_commit_clears_the_fields_and_a_saved_message_restores_the_draft() {
        let mut model = ComposerModel::default();
        model
            .toggle_amend(draft("wip", ""), Some(draft("last", "")))
            .unwrap();
        assert_eq!(model.committed(), Some(Draft::default()));
        assert!(!model.amend);

        model.start_edit(draft("next", "b"), "abc", draft("s", ""));
        assert_eq!(model.committed(), Some(draft("next", "b")));
        assert!(model.editing.is_none());
    }
}
