//! A one-time notice that suggests writing a commit-graph for a large repository without one.
//!
//! `tuig-git` does the file system check. This screen shows the footer notice and remembers the repository in
//! `layout.json`, so the notice appears once per repository. The app never runs the command itself.

use crate::shell::{GitResult, Msg, Shell};
use opentui::prelude::*;
use tuig_ui_model::preferences::{LayoutPreferences, save_layout_preferences};

const NOTICE: &str =
    "Large repository without a commit-graph. Run `git maintenance start` to speed up history.";

impl Shell {
    pub(crate) fn start_commit_graph_hint(&mut self, app: &App) {
        let repo = self.repo.clone();
        self.spawn(
            app,
            |tasks| &mut tasks.commit_graph,
            async move { repo.commit_graph_hint().await },
            Msg::CommitGraphHint,
        );
    }

    /// Shows the notice for a repository that has not had it, and records that it was shown. A failed check shows
    /// nothing: the hint is optional.
    pub(crate) fn commit_graph_hint_loaded(&mut self, result: GitResult<Option<String>>) {
        let Ok(Some(git_dir)) = result else {
            return;
        };
        if self.commit_graph_hint_dismissed.contains(&git_dir) {
            return;
        }
        self.commit_graph_hint_dismissed.push(git_dir);
        if let Some(path) = &self.sidebar.prefs_path {
            let _ = save_layout_preferences(
                &LayoutPreferences {
                    commit_graph_hint_dismissed: Some(self.commit_graph_hint_dismissed.clone()),
                    ..LayoutPreferences::default()
                },
                path,
            );
        }
        self.set_notice(NOTICE.to_owned());
    }
}

#[cfg(test)]
#[path = "commit_graph_hint_tests.rs"]
mod tests;
