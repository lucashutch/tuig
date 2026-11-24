//! Previews and runs an undo of the latest commit-like reflog entry on the
//! current branch. Port of `src/git/undo.ts`.
//!
//! Failures that the TypeScript code raised as plain `Error` are
//! `GitError::Io` values of kind `Other`.

use std::io::ErrorKind;
use std::sync::LazyLock;

use regex::Regex;
use sha2::{Digest, Sha256};

use crate::process::GitError;
use crate::repository::GitRepositoryService;
use crate::types::UndoPreview;

fn fail(message: &str) -> GitError {
    GitError::Io(std::io::Error::other(message.to_string()))
}

static REFLOG_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^\t]+\t(.+)$").expect("static regex")
});
static SUPPORTED_ACTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(commit: |commit \(amend\): |reset: moving to |merge .+: )")
        .expect("static regex")
});

const STATE_PATHS: [&str; 8] = [
    "logs/HEAD",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_START",
];

pub async fn get_undo_preview(repo: &GitRepositoryService) -> Result<UndoPreview, GitError> {
    let branch = repo
        .git(&["symbolic-ref", "--quiet", "HEAD"])
        .await
        .ok()
        .map(|r| r.stdout.trim().to_string())
        .unwrap_or_default();
    if branch.is_empty() {
        return Err(fail("Cannot undo while HEAD is detached"));
    }
    let mut args = vec!["rev-parse", "--path-format=absolute"];
    for path in STATE_PATHS {
        args.push("--git-path");
        args.push(path);
    }
    let output = repo.git(&args).await?.stdout;
    let paths: Vec<&str> = output.trim().split('\n').collect();
    for path in paths.iter().skip(1) {
        match std::fs::metadata(path) {
            Ok(_) => return Err(fail("Cannot undo while a Git operation is active")),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let status = repo
        .git(&[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--ignore-submodules=none",
        ])
        .await?;
    let entries: Vec<&str> = status
        .stdout
        .split('\0')
        .filter(|e| !e.is_empty())
        .collect();
    let ignored_paths: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry.strip_prefix("!! "))
        .map(|path| path.strip_suffix('/').unwrap_or(path))
        .collect();
    if entries.iter().any(|entry| !entry.starts_with("!! ")) {
        return Err(fail("Cannot undo with tracked changes or untracked files"));
    }
    // Read the raw log: its old object ID is the actual operation boundary.
    // Hash all bytes so even identical entries appended in one second are stale.
    let log =
        std::fs::read(paths[0]).map_err(|_| fail("Cannot undo: HEAD reflog is unavailable"))?;
    let text = String::from_utf8_lossy(&log);
    let latest = text.trim_end().split('\n').next_back().unwrap_or("");
    let Some(captures) = REFLOG_ENTRY.captures(latest) else {
        return Err(fail("Cannot undo: invalid HEAD reflog entry"));
    };
    let target = captures[1].to_string();
    let head = captures[2].to_string();
    let action = captures[3].to_string();
    // Reflog messages are user-controlled, not authenticated provenance.
    // This allowlist assumes ordinary Git-generated messages in a trusted repo.
    if action.starts_with("tuig undo") {
        return Err(fail("Cannot undo the previous undo"));
    }
    if !SUPPORTED_ACTION.is_match(&action) {
        return Err(fail(&format!(
            "Cannot undo unsupported reflog action: {action}"
        )));
    }
    // Cherry-pick logs do not record the invocation boundary. A completed
    // sequence cannot reliably be distinguished from separate single picks.
    if target.bytes().all(|b| b == b'0') {
        return Err(fail("Cannot undo an initial commit"));
    }
    if head == target {
        return Err(fail("Cannot undo: latest reflog entry did not move HEAD"));
    }
    let current = repo
        .git(&["rev-parse", "--verify", "HEAD"])
        .await?
        .stdout
        .trim()
        .to_string();
    if current != head {
        return Err(fail("Cannot undo: HEAD changed while reading reflog"));
    }
    repo.git(&["cat-file", "-e", &format!("{target}^{{commit}}")])
        .await?;
    if !ignored_paths.is_empty() {
        // reset --keep can overwrite ignored content. Check both prefix
        // directions: a target file can replace a directory, or need a
        // directory where an ignored file currently exists. Matching ignored
        // directories are treated as occupied without walking their trees.
        let listing = repo
            .git(&["ls-tree", "-r", "-z", "--name-only", &target])
            .await?
            .stdout;
        let target_paths: Vec<&str> = listing.split('\0').filter(|p| !p.is_empty()).collect();
        let overlaps = ignored_paths.iter().any(|ignored| {
            target_paths.iter().any(|tracked| {
                tracked == ignored
                    || tracked
                        .strip_prefix(ignored)
                        .is_some_and(|rest| rest.starts_with('/'))
                    || ignored
                        .strip_prefix(tracked)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
        });
        if overlaps {
            return Err(fail(
                "Cannot undo: target paths overlap ignored untracked files or directories",
            ));
        }
    }
    let digest = Sha256::digest(&log);
    let reflog_token = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(UndoPreview {
        head,
        target,
        branch,
        action,
        reflog_token,
    })
}

pub async fn undo(repo: &GitRepositoryService, preview: &UndoPreview) -> Result<(), GitError> {
    let current = get_undo_preview(repo).await?;
    if current != *preview {
        return Err(fail("Cannot undo: preview is stale; refresh and try again"));
    }
    // reset has no expected-old-HEAD option. External Git commands can race
    // after validation; callers must not run concurrent repository mutations.
    repo.git_env(
        &[
            "reset",
            "--keep",
            "--no-recurse-submodules",
            &current.target,
        ],
        &[("GIT_REFLOG_ACTION", "tuig undo")],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::process::run_git;
    use crate::repository::{GitRepository, GitRepositoryService};
    use crate::test_util::{TempDir, temp_repo};

    struct Fixture {
        dir: TempDir,
        repo: GitRepositoryService,
        initial: String,
    }

    async fn git(dir: &Path, args: &[&str]) -> String {
        run_git(args, Some(dir))
            .await
            .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
            .stdout
            .trim()
            .to_string()
    }

    async fn commit(dir: &Path, content: &str) -> String {
        std::fs::write(dir.join("file"), content).unwrap();
        git(dir, &["add", "file"]).await;
        git(dir, &["commit", "-m", content.trim()]).await;
        git(dir, &["rev-parse", "HEAD"]).await
    }

    async fn fixture() -> Fixture {
        let dir = temp_repo().await;
        git(dir.path(), &["config", "user.name", "Test"]).await;
        git(dir.path(), &["config", "user.email", "test@example.com"]).await;
        let initial = commit(dir.path(), "initial\n").await;
        let repo = GitRepositoryService::open(dir.path()).await.unwrap();
        Fixture { dir, repo, initial }
    }

    fn message<T>(result: Result<T, GitError>) -> String {
        result.err().expect("expected an error").to_string()
    }

    #[tokio::test]
    async fn undo_restores_the_previous_tip_and_tree() {
        for operation in ["commit", "amend", "reset", "merge"] {
            let f = fixture().await;
            let root = f.dir.path();
            let mut target = f.initial.clone();
            let mut content = "initial\n";
            match operation {
                "commit" => {
                    commit(root, "new\n").await;
                }
                "amend" => {
                    std::fs::write(root.join("file"), "amended\n").unwrap();
                    git(root, &["add", "file"]).await;
                    git(root, &["commit", "--amend", "-m", "amended"]).await;
                }
                "reset" => {
                    target = commit(root, "new\n").await;
                    content = "new\n";
                    git(root, &["reset", "--hard", &f.initial]).await;
                }
                _ => {
                    git(root, &["switch", "-c", "topic"]).await;
                    commit(root, "topic\n").await;
                    git(root, &["switch", "main"]).await;
                    git(root, &["merge", "--no-ff", "topic", "-m", "merge"]).await;
                }
            }
            let preview = f.repo.get_undo_preview().await.unwrap();
            assert_eq!(preview.target, target, "{operation}");
            assert_eq!(preview.reflog_token.len(), 64);
            f.repo.undo(&preview).await.unwrap();
            assert_eq!(
                git(root, &["rev-parse", "HEAD"]).await,
                target,
                "{operation}"
            );
            assert_eq!(std::fs::read_to_string(root.join("file")).unwrap(), content);
            assert_eq!(git(root, &["status", "--porcelain"]).await, "");
            assert!(message(f.repo.get_undo_preview().await).contains("previous undo"));
        }
    }

    #[tokio::test]
    async fn dirty_tracked_staged_and_untracked_data_are_preserved() {
        let f = fixture().await;
        let root = f.dir.path();
        commit(root, "new\n").await;
        let preview = f.repo.get_undo_preview().await.unwrap();
        std::fs::write(root.join("file"), "staged\n").unwrap();
        git(root, &["add", "file"]).await;
        std::fs::write(root.join("file"), "unstaged\n").unwrap();
        std::fs::write(root.join("untracked"), "keep\n").unwrap();
        let before = git(root, &["status", "--porcelain"]).await;

        assert!(message(f.repo.undo(&preview).await).contains("tracked changes or untracked"));

        assert_eq!(git(root, &["status", "--porcelain"]).await, before);
        assert_eq!(
            std::fs::read_to_string(root.join("file")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("untracked")).unwrap(),
            "keep\n"
        );
    }

    #[tokio::test]
    async fn undo_refuses_ignored_prefix_collisions() {
        for target_directory in [false, true] {
            let f = fixture().await;
            let root = f.dir.path();
            if target_directory {
                std::fs::create_dir(root.join("artifact")).unwrap();
            }
            let tracked = if target_directory {
                "artifact/file"
            } else {
                "artifact"
            };
            std::fs::write(root.join(tracked), "original\n").unwrap();
            git(root, &["add", "artifact"]).await;
            git(root, &["commit", "-m", "track artifact"]).await;
            git(root, &["rm", "-r", "artifact"]).await;
            std::fs::write(root.join(".gitignore"), "artifact\n").unwrap();
            git(root, &["add", ".gitignore"]).await;
            git(root, &["commit", "-m", "ignore artifact"]).await;
            let preview = f.repo.get_undo_preview().await.unwrap();
            if !target_directory {
                std::fs::create_dir(root.join("artifact")).unwrap();
            }
            let precious = root.join(if target_directory {
                "artifact"
            } else {
                "artifact/precious"
            });
            std::fs::write(&precious, "keep\n").unwrap();

            assert!(message(f.repo.undo(&preview).await).contains("overlap ignored"));

            assert_eq!(std::fs::read_to_string(&precious).unwrap(), "keep\n");
            assert_eq!(git(root, &["rev-parse", "HEAD"]).await, preview.head);
        }
    }

    #[tokio::test]
    async fn undo_allows_unrelated_ignored_build_directories() {
        let f = fixture().await;
        let root = f.dir.path();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        git(root, &["add", ".gitignore"]).await;
        commit(root, "new\n").await;
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/dependency"), "keep\n").unwrap();

        let preview = f.repo.get_undo_preview().await.unwrap();
        f.repo.undo(&preview).await.unwrap();

        assert_eq!(git(root, &["rev-parse", "HEAD"]).await, f.initial);
        assert_eq!(
            std::fs::read_to_string(root.join("node_modules/dependency")).unwrap(),
            "keep\n"
        );
    }

    #[tokio::test]
    async fn same_hash_reflog_entries_and_modified_previews_are_stale() {
        let f = fixture().await;
        let root = f.dir.path();
        commit(root, "new\n").await;
        let preview = f.repo.get_undo_preview().await.unwrap();
        let tampered = UndoPreview {
            target: preview.head.clone(),
            ..preview.clone()
        };
        assert!(message(f.repo.undo(&tampered).await).contains("stale"));
        git(root, &["reset", "--hard", "HEAD"]).await;
        assert!(message(f.repo.get_undo_preview().await).contains("did not move HEAD"));
        assert!(message(f.repo.undo(&preview).await).contains("did not move HEAD"));
        git(root, &["reset", "--hard", &preview.target]).await;
        git(root, &["reset", "--hard", &preview.head]).await;
        assert!(message(f.repo.undo(&preview).await).contains("stale"));
    }

    #[tokio::test]
    async fn cherry_pick_checkout_detached_head_and_active_operations_are_refused() {
        let f = fixture().await;
        let root = f.dir.path();
        git(root, &["switch", "-c", "topic"]).await;
        let picked = commit(root, "picked\n").await;
        git(root, &["switch", "main"]).await;
        git(root, &["cherry-pick", &picked]).await;
        assert!(message(f.repo.get_undo_preview().await).contains("unsupported"));

        commit(root, "new\n").await;
        git(root, &["switch", "-c", "other"]).await;
        assert!(message(f.repo.get_undo_preview().await).contains("unsupported"));
        git(root, &["checkout", "--detach"]).await;
        assert!(message(f.repo.get_undo_preview().await).contains("detached"));
        git(root, &["switch", "main"]).await;
        let head = git(root, &["rev-parse", "HEAD"]).await;
        git(
            root,
            &[
                "-c",
                "core.logAllRefUpdates=true",
                "update-ref",
                "-m",
                "rebase (finish): test",
                "HEAD",
                &head,
            ],
        )
        .await;
        assert!(message(f.repo.get_undo_preview().await).contains("unsupported"));
        std::fs::create_dir(root.join(".git/rebase-merge")).unwrap();
        assert!(message(f.repo.get_undo_preview().await).contains("operation is active"));
    }
}
