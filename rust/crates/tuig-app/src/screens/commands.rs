//! Repository commands behind menus and the palette. Ports `src/ui/runtime-commands.ts` (`perform`,
//! `runMenuAction`, `checkoutBranch`, `runFileAction`, the bulk stage and discard commands) and the view actions of
//! `runMenuAction` in `src/ui/runtime-graph-menu.ts`.
//!
//! Every mutation goes through [`Shell::perform`] (one at a time, in the `mutation` task slot). Remote
//! operations also carry a [`CancelToken`], which Esc cancels.

use crate::shell::{GitResult, Shell};
use opentui::prelude::*;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tuig_git::process::CancelToken;
use tuig_git::repository::GitRepository;
use tuig_git::types::{BranchRef, ChangedFile, FileState, ResetMode};
use tuig_ui_model::graph_menu::{
    ConfirmRequest, GraphMenuAction, GraphMenuItem, GraphMenuTarget, branch_deletion_copies,
};
use tuig_widgets::commit_text::short_sha;
use tuig_widgets::decorations::display_branch_name;

use crate::screens::popup::MenuRequest;

/// How long "Discard all" stays armed. `discardArmed` resets after 5 seconds.
const DISCARD_ARM: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct CommandsState {
    /// Cancels the running remote operation.
    pub cancel: Option<CancelToken>,
    pub discard_armed: Option<Instant>,
    /// The commit a comparison starts from. `comparisonStartSha`.
    pub comparison_start: Option<String>,
}

/// What a file action does to its files. `runFileAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileAction {
    Stage,
    Unstage,
    Discard,
}

fn last_component(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

fn same_directory(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

impl Shell {
    pub(crate) fn notify(&mut self, text: impl Into<String>) {
        self.notice = Some(text.into());
    }

    /// Runs a remote operation that Esc can cancel.
    pub(crate) fn perform_remote<F, Fut>(&mut self, app: &App, label: &str, make: F)
    where
        F: FnOnce(Arc<dyn GitRepository>, CancelToken) -> Fut,
        Fut: Future<Output = GitResult<()>> + Send + 'static,
    {
        if let Some(running) = &self.diff.mutation {
            self.notice = Some(format!("{running} is still running"));
            return;
        }
        let token = CancelToken::new();
        self.commands.cancel = Some(token.clone());
        let future = make(self.repo.clone(), token);
        self.perform(app, label, future);
    }

    /// Esc while a remote operation runs. `cancelActiveMutation`. Returns whether there was one to cancel.
    pub(crate) fn cancel_mutation(&mut self) -> bool {
        if self.diff.mutation.is_none() {
            return false;
        }
        match &self.commands.cancel {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    pub(crate) fn copy_text(&mut self, app: &App, text: &str, notice: String) {
        if app.copy_to_clipboard(text) {
            self.notice = Some(notice);
        }
    }

    /// Ports `checkoutBranch`.
    pub(crate) fn checkout_branch(&mut self, app: &App, branch: BranchRef) {
        if branch.current {
            return self.notify(format!("Already on {}", branch.name));
        }
        let repo = self.repo.clone();
        if !branch.remote {
            let name = branch.name.clone();
            return self.perform(app, &format!("Switching to {name}…"), async move {
                repo.switch_branch(&name).await
            });
        }
        let short = branch
            .name
            .split_once('/')
            .map_or(branch.name.as_str(), |(_, rest)| rest)
            .to_owned();
        let local = self.snapshot.as_ref().and_then(|snapshot| {
            snapshot
                .branches
                .iter()
                .find(|candidate| !candidate.remote && candidate.name == short)
                .cloned()
        });
        let Some(local) = local else {
            let remote = branch.name.clone();
            return self.perform(app, &format!("Switching to {short}…"), async move {
                repo.checkout_remote_branch(&short, &remote, false).await
            });
        };
        if local.sha == branch.sha {
            return self.perform(app, &format!("Switching to {short}…"), async move {
                repo.switch_branch(&short).await
            });
        }
        let remote = branch.name.clone();
        self.confirm_then(
            ConfirmRequest {
                title: "Overwrite local branch".to_owned(),
                lines: vec![
                    format!("Your local {short} differs from {remote}."),
                    "Continuing moves the local branch onto the remote tip,".to_owned(),
                    "abandoning any local commits it has.".to_owned(),
                ],
                confirm_label: format!("Overwrite local {short}"),
                destructive: true,
            },
            move |shell, app| {
                let repo = shell.repo.clone();
                shell.perform(
                    app,
                    &format!("Resetting {short} to {remote}…"),
                    async move { repo.checkout_remote_branch(&short, &remote, true).await },
                );
            },
        );
    }

    /// Ports `runMenuAction` of `runtime-graph-menu.ts` and `runtime-commands.ts`.
    pub(crate) fn run_menu_action(
        &mut self,
        app: &App,
        action: GraphMenuAction,
        target: GraphMenuTarget,
    ) {
        use GraphMenuAction as A;
        let sha = (!target.sha.is_empty()).then(|| target.sha.clone());
        let repo = self.repo.clone();
        let branch = target.branch.clone();
        // What rebase and reset move to: the branch when one was clicked, else the commit.
        let reference = branch
            .as_ref()
            .map_or_else(|| target.sha.clone(), |branch| branch.name.clone());
        match action {
            A::FileHistory => {
                if let Some(file) = target.file {
                    self.show_file_history(app, file, sha);
                }
            }
            A::BlameLine => {
                if let (Some(file), Some(line)) = (target.file, target.line) {
                    self.blame_line(app, file.path, line, sha);
                }
            }
            A::LineHistory => {
                if let (Some(file), Some(line)) = (target.file, target.line) {
                    self.show_line_history(app, file, line, sha);
                }
            }
            A::SelectComparisonStart => {
                self.commands.comparison_start = Some(target.sha.clone());
                self.notify(format!(
                    "Comparison start: {} · right-click another commit",
                    short_sha(&target.sha)
                ));
            }
            A::ClearComparisonStart => {
                self.commands.comparison_start = None;
                self.notify("Comparison start cleared");
            }
            // TODO: `openComparison` needs the comparison diff in the commit view.
            A::CompareWithSelected => self.notify("Comparing two commits is not available yet"),
            A::OpenSubmodule => {
                if let Some(submodule) = target.submodule {
                    self.open_submodule(app, submodule);
                }
            }
            A::OpenWorktree => {
                if let Some(worktree) = target.worktree {
                    self.open_worktree(app, worktree);
                }
            }
            A::CopyPath => {
                let path = target
                    .file
                    .as_ref()
                    .map(|file| file.path.clone())
                    .or_else(|| {
                        target
                            .worktree
                            .as_ref()
                            .map(|worktree| worktree.path.clone())
                    })
                    .or_else(|| {
                        target
                            .submodule
                            .as_ref()
                            .map(|submodule| submodule.path.clone())
                    });
                if let Some(path) = path {
                    self.copy_text(app, &path, format!("Copied {path}"));
                }
            }
            A::StageFile | A::UnstageFile => {
                let Some(file) = target.file else { return };
                let staging = action == A::StageFile;
                self.run_file_action(
                    app,
                    if staging {
                        FileAction::Stage
                    } else {
                        FileAction::Unstage
                    },
                    vec![file],
                    false,
                );
            }
            A::StageHunk | A::UnstageHunk | A::RevertHunk => {
                if let Some(patch) = target.hunk_patch {
                    self.hunk_menu_action(app, action, patch);
                }
            }
            A::DiscardFile => {
                if let Some(file) = target.file {
                    self.run_file_action(app, FileAction::Discard, vec![file], false);
                }
            }
            A::LockWorktree | A::UnlockWorktree => {
                let Some(worktree) = target.worktree else {
                    return;
                };
                let lock = action == A::LockWorktree;
                self.perform(
                    app,
                    &format!("{} worktree…", if lock { "Locking" } else { "Unlocking" }),
                    async move { repo.lock_worktree(&worktree.path, lock, None).await },
                );
            }
            A::RemoveWorktree => {
                let Some(worktree) = target.worktree else {
                    return;
                };
                let name = last_component(&worktree.path).to_owned();
                self.confirm_then(
                    ConfirmRequest {
                        title: "Remove worktree".to_owned(),
                        lines: vec![format!("Remove the worktree at {}?", worktree.path)],
                        confirm_label: format!("Remove {name}"),
                        destructive: true,
                    },
                    move |shell, app| {
                        let repo = shell.repo.clone();
                        shell.perform(app, &format!("Removing {name}…"), async move {
                            repo.remove_worktree(&worktree.path, false).await
                        });
                    },
                );
            }
            A::UpdateSubmodule | A::InitSubmodule | A::SyncSubmodule => {
                let Some(submodule) = target.submodule else {
                    return;
                };
                let sync = action == A::SyncSubmodule;
                let init = action == A::InitSubmodule;
                let label = format!(
                    "{} {}…",
                    if sync { "Syncing" } else { "Updating" },
                    submodule.path
                );
                self.perform(app, &label, async move {
                    if sync {
                        repo.sync_submodule(&submodule.path).await
                    } else {
                        repo.update_submodule(&submodule.path, init).await
                    }
                });
            }
            A::PushTag => {
                let Some(tag) = target.tag else { return };
                self.perform_remote(app, &format!("Pushing tag {tag}…"), move |repo, cancel| async move {
                    repo.push_tag(&tag, None, Some(&cancel)).await
                });
            }
            A::DeleteTag => {
                let Some(tag) = target.tag else { return };
                self.confirm_then(
                    ConfirmRequest {
                        title: "Delete tag".to_owned(),
                        lines: vec![format!("Delete local tag {tag}?")],
                        confirm_label: format!("Delete {tag}"),
                        destructive: true,
                    },
                    move |shell, app| {
                        let repo = shell.repo.clone();
                        shell.perform(app, &format!("Deleting tag {tag}…"), async move {
                            repo.delete_tag(&tag).await
                        });
                    },
                );
            }
            A::DropStash => {
                let Some(stash) = target.stash else { return };
                self.confirm_then(
                    ConfirmRequest {
                        title: "Drop stash".to_owned(),
                        lines: vec![format!("Drop {}?", stash.reference), stash.subject.clone()],
                        confirm_label: format!("Drop {}", stash.reference),
                        destructive: true,
                    },
                    move |shell, app| {
                        let repo = shell.repo.clone();
                        shell.perform(app, &format!("Dropping {}…", stash.reference), async move {
                            repo.drop_stash(&stash.reference).await
                        });
                    },
                );
            }
            A::RenameStash => {
                let Some(stash) = target.stash else { return };
                self.open_name_prompt(
                    app,
                    "Rename stash",
                    "stash name",
                    move |shell, app, name| {
                        let repo = shell.repo.clone();
                        shell.perform(app, &format!("Renaming {}…", stash.reference), async move {
                            repo.rename_stash(&stash.reference, &name).await
                        });
                    },
                );
            }
            A::ApplyStash => {
                let Some(stash) = target.stash else { return };
                self.perform(app, &format!("Applying {}…", stash.reference), async move {
                    repo.apply_stash(&stash.reference, false).await
                });
            }
            A::PopStash => {
                let Some(stash) = target.stash else { return };
                self.confirm_then(
                    ConfirmRequest {
                        title: "Pop stash".to_owned(),
                        lines: vec![
                            format!(
                                "Apply {} and remove it from the stash list?",
                                stash.reference
                            ),
                            stash.subject.clone(),
                        ],
                        confirm_label: format!("Pop {}", stash.reference),
                        destructive: true,
                    },
                    move |shell, app| {
                        let repo = shell.repo.clone();
                        shell.perform(app, &format!("Popping {}…", stash.reference), async move {
                            repo.pop_stash(&stash.reference).await
                        });
                    },
                );
            }
            A::CopySha => {
                let short = short_sha(&target.sha).to_owned();
                self.copy_text(app, &short, format!("Copied {short}"));
            }
            A::CopyBranch => {
                if let Some(branch) = branch {
                    self.copy_text(app, &branch.name, format!("Copied {}", branch.name));
                }
            }
            A::CheckoutBranch => {
                if let Some(branch) = branch {
                    self.checkout_branch(app, branch);
                }
            }
            A::CheckoutCommit => {
                let sha = target.sha.clone();
                self.perform(
                    app,
                    &format!("Checking out {}…", short_sha(&sha)),
                    async move { repo.checkout_commit(&sha).await },
                );
            }
            A::CreateBranch => {
                let sha = target.sha.clone();
                self.open_name_prompt(
                    app,
                    "Create branch",
                    "branch name",
                    move |shell, app, name| {
                        let repo = shell.repo.clone();
                        shell.perform(app, &format!("Creating {name}…"), async move {
                            repo.create_branch(&name, Some(&sha), false).await
                        });
                    },
                );
            }
            A::CreateTag => {
                let sha = target.sha.clone();
                self.open_name_prompt(app, "Create tag", "tag name", move |shell, app, name| {
                    let repo = shell.repo.clone();
                    shell.perform(app, &format!("Creating tag {name}…"), async move {
                        repo.create_tag(&name, Some(&sha)).await
                    });
                });
            }
            A::CherryPick => {
                let sha = target.sha.clone();
                self.perform(
                    app,
                    &format!("Cherry-picking {}…", short_sha(&sha)),
                    async move { repo.cherry_pick(&sha).await },
                );
            }
            A::RebaseOnto => {
                self.perform(app, &format!("Rebasing onto {reference}…"), async move {
                    repo.rebase_onto(&reference).await
                });
            }
            A::DeleteBranch
            | A::DeleteBranchLocal
            | A::DeleteBranchRemote
            | A::DeleteBranchBoth => {
                if let Some(branch) = branch {
                    self.delete_branch_action(action, branch);
                }
            }
            A::ResetSoft | A::ResetMixed | A::ResetHard => {
                let mode = match action {
                    A::ResetSoft => ResetMode::Soft,
                    A::ResetHard => ResetMode::Hard,
                    _ => ResetMode::Mixed,
                };
                let current = self
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.branch.clone())
                    .unwrap_or_else(|| "HEAD".to_owned());
                let destination = branch.as_ref().map_or_else(
                    || short_sha(&target.sha).to_owned(),
                    |branch| display_branch_name(&branch.name).to_owned(),
                );
                let label = format!("{current} → {destination}");
                if mode != ResetMode::Hard {
                    let word = if mode == ResetMode::Soft {
                        "soft"
                    } else {
                        "mixed"
                    };
                    return self.perform(
                        app,
                        &format!("Resetting ({word}) {label}…"),
                        async move { repo.reset_to(&reference, mode).await },
                    );
                }
                self.confirm_then(
                    ConfirmRequest {
                        title: "Hard reset".to_owned(),
                        lines: vec![
                            format!("Move {current} to {destination}"),
                            "and throw away all uncommitted changes to tracked files.".to_owned(),
                            "This cannot be undone from the working tree.".to_owned(),
                        ],
                        confirm_label: "Reset --hard".to_owned(),
                        destructive: true,
                    },
                    move |shell, app| {
                        let repo = shell.repo.clone();
                        shell.perform(app, &format!("Resetting (hard) {label}…"), async move {
                            repo.reset_to(&reference, ResetMode::Hard).await
                        });
                    },
                );
            }
        }
    }

    /// The delete actions of the branch menu, with the confirmation and the linked-worktree dialog.
    fn delete_branch_action(&mut self, action: GraphMenuAction, branch: BranchRef) {
        use GraphMenuAction as A;
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        let copies = branch_deletion_copies(&branch, &snapshot.branches);
        let local = match action {
            A::DeleteBranchRemote => None,
            A::DeleteBranch => (!branch.remote).then(|| branch.clone()),
            _ => copies.local.cloned(),
        };
        let remote = match action {
            A::DeleteBranchLocal => None,
            A::DeleteBranch => branch.remote.then(|| branch.clone()),
            _ => copies.remote.cloned(),
        };
        if (local.is_none() && remote.is_none())
            || local.as_ref().is_some_and(|local| local.current)
        {
            return;
        }
        let linked_worktree = local.as_ref().and_then(|local| {
            snapshot
                .worktrees
                .iter()
                .find(|candidate| {
                    candidate.branch.as_deref() == Some(local.name.as_str())
                        && !same_directory(&candidate.path, &snapshot.root)
                })
                .cloned()
        });
        let names = [
            local
                .as_ref()
                .map(|local| format!("local branch {}", local.name)),
            remote
                .as_ref()
                .map(|remote| format!("remote branch {}", remote.name)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" and ");
        if let Some(worktree) = linked_worktree {
            let name = last_component(&worktree.path).to_owned();
            let both_label = format!("Delete branch and {name}");
            let remove_label = format!("Remove {name} only");
            let items = vec![
                GraphMenuItem::info(format!(
                    "{} is checked out at:",
                    display_branch_name(
                        &local.as_ref().map_or_else(String::new, |l| l.name.clone())
                    )
                )),
                GraphMenuItem::info(worktree.path.clone()),
                GraphMenuItem::separator(),
                GraphMenuItem::new(both_label.clone()).destructive(),
                GraphMenuItem::new(remove_label.clone()).destructive(),
                GraphMenuItem::new("Cancel"),
            ];
            let width = tuig_ui_model::graph_menu::menu_width(&items);
            let (columns, rows) = (i64::from(self.layout.width), i64::from(self.layout.height));
            self.open_popup(MenuRequest {
                title: "Branch has a worktree".to_owned(),
                x: ((columns - width) / 2).max(0),
                y: ((rows - items.len() as i64) / 2).max(0),
                items,
                selected: Some(3),
                on_select: Box::new(move |shell, app, item| {
                    let repo = shell.repo.clone();
                    if item.label == remove_label {
                        shell.perform(app, &format!("Removing {name}…"), async move {
                            repo.remove_worktree(&worktree.path, false).await
                        });
                    } else if item.label == both_label {
                        let label = format!("Deleting {names} and worktree {name}…");
                        let has_remote = remote.is_some();
                        let local_name = local.map(|local| local.name);
                        let remote_name = remote.map(|remote| remote.name);
                        let run = move |repo: Arc<dyn GitRepository>, cancel: CancelToken| async move {
                            repo.remove_worktree(&worktree.path, false).await?;
                            if let Some(remote) = remote_name {
                                repo.delete_remote_branch(&remote, Some(&cancel)).await?;
                            }
                            if let Some(local) = local_name {
                                repo.delete_branch(&local, true, false).await?;
                            }
                            Ok(())
                        };
                        if has_remote {
                            shell.perform_remote(app, &label, run);
                        } else {
                            shell.perform(app, &label, run(repo, CancelToken::new()));
                        }
                    }
                }),
            });
            return;
        }
        let lines = {
            let mut lines = vec![format!("Delete {names}?")];
            if remote.is_some() {
                lines.push("This deletes the branch on the remote server.".to_owned());
            }
            lines.push("Commits only on this branch become unreachable.".to_owned());
            lines
        };
        let has_remote = remote.is_some();
        self.confirm_then(
            ConfirmRequest {
                title: "Delete branch".to_owned(),
                lines,
                confirm_label: format!("Delete {}", display_branch_name(&branch.name)),
                destructive: true,
            },
            move |shell, app| {
                let label = format!("Deleting {names}…");
                let local_name = local.map(|local| local.name);
                let remote_name = remote.map(|remote| remote.name);
                let run = move |repo: Arc<dyn GitRepository>, cancel: CancelToken| async move {
                    // Keep the local copy if the server rejects the deletion.
                    if let Some(remote) = remote_name {
                        repo.delete_remote_branch(&remote, Some(&cancel)).await?;
                    }
                    if let Some(local) = local_name {
                        repo.delete_branch(&local, true, false).await?;
                    }
                    Ok(())
                };
                if has_remote {
                    shell.perform_remote(app, &label, run);
                } else {
                    let repo = shell.repo.clone();
                    shell.perform(app, &label, run(repo, CancelToken::new()));
                }
            },
        );
    }

    /// Ports `runFileAction`.
    pub(crate) fn run_file_action(
        &mut self,
        app: &App,
        action: FileAction,
        files: Vec<ChangedFile>,
        directory: bool,
    ) {
        let mut paths: Vec<String> = Vec::new();
        for file in &files {
            if !paths.contains(&file.path) {
                paths.push(file.path.clone());
            }
        }
        let Some(first) = paths.first() else {
            return;
        };
        let target = if directory {
            format!("{} files", paths.len())
        } else {
            first.clone()
        };
        let repo = self.repo.clone();
        match action {
            FileAction::Stage => self.perform(app, &format!("Staging {target}…"), async move {
                repo.stage(&paths).await
            }),
            FileAction::Unstage => self.perform(app, &format!("Unstaging {target}…"), async move {
                repo.unstage(&paths).await
            }),
            FileAction::Discard => {
                let deletes_untracked = files.iter().any(|file| file.state == FileState::Untracked);
                let label = format!("Discarding {target}…");
                let run = move |shell: &mut Shell, app: &App| {
                    shell.perform(app, &label, async move { repo.discard(&paths).await });
                };
                if !directory && !deletes_untracked {
                    return run(self, app);
                }
                let mut lines = vec![if directory {
                    format!("Discard changes in {target}?")
                } else {
                    format!("Delete untracked {target}?")
                }];
                if deletes_untracked {
                    lines.push("Untracked content will be deleted.".to_owned());
                }
                self.confirm_then(
                    ConfirmRequest {
                        title: "Discard changes".to_owned(),
                        lines,
                        confirm_label: "Discard changes".to_owned(),
                        destructive: true,
                    },
                    run,
                );
            }
        }
    }

    fn working_files(&self, staged: bool) -> Vec<ChangedFile> {
        self.snapshot.as_ref().map_or_else(Vec::new, |snapshot| {
            snapshot
                .files
                .iter()
                .filter(|file| if staged { file.staged } else { file.unstaged })
                .cloned()
                .collect()
        })
    }

    /// The `s` and `u` keys: stage or unstage the selected file. With no file selected the key does nothing.
    pub(crate) fn stage_selected_key(&mut self, app: &App, stage: bool) {
        let Some(path) = self.files.selected.as_ref().map(|file| file.path.clone()) else {
            return;
        };
        let repo = self.repo.clone();
        let label = if stage { "Staging…" } else { "Unstaging…" };
        self.perform(app, label, async move {
            if stage {
                repo.stage(&[path]).await
            } else {
                repo.unstage(&[path]).await
            }
        });
    }

    pub(crate) fn stage_all(&mut self, app: &App) {
        let paths: Vec<String> = self
            .working_files(false)
            .into_iter()
            .map(|file| file.path)
            .collect();
        if paths.is_empty() {
            return self.notify("Nothing to stage");
        }
        let repo = self.repo.clone();
        self.perform(app, "Staging all…", async move { repo.stage(&paths).await });
    }

    pub(crate) fn unstage_all(&mut self, app: &App) {
        let paths: Vec<String> = self
            .working_files(true)
            .into_iter()
            .map(|file| file.path)
            .collect();
        if paths.is_empty() {
            return self.notify("Nothing to unstage");
        }
        let repo = self.repo.clone();
        self.perform(app, "Unstaging all…", async move {
            repo.unstage(&paths).await
        });
    }

    /// Discards every unstaged change after a second request within [`DISCARD_ARM`].
    pub(crate) fn discard_all(&mut self, app: &App) {
        if self.working_files(false).is_empty() {
            return self.notify("Nothing to discard");
        }
        let armed = self
            .commands
            .discard_armed
            .is_some_and(|at| at.elapsed() < DISCARD_ARM);
        if !armed {
            self.commands.discard_armed = Some(Instant::now());
            return self.notify("Discard all unstaged changes? Press again to confirm");
        }
        self.commands.discard_armed = None;
        let repo = self.repo.clone();
        self.perform(app, "Discarding…", async move { repo.discard_all().await });
    }
}
