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
use crate::types::{CommandResult, UndoPreview};

/// Runs Git in the repository root.
pub type GitRunner<'a> = &'a dyn Fn(&[&str]) -> Result<CommandResult, GitError>;
/// Runs Git in the repository root with extra environment variables.
pub type GitEnvRunner<'a> = &'a dyn Fn(&[&str], &[(&str, &str)]) -> Result<CommandResult, GitError>;

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

pub fn get_undo_preview(git: GitRunner) -> Result<UndoPreview, GitError> {
    let branch = git(&["symbolic-ref", "--quiet", "HEAD"])
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
    let output = git(&args)?.stdout;
    let paths: Vec<&str> = output.trim().split('\n').collect();
    for path in paths.iter().skip(1) {
        match std::fs::metadata(path) {
            Ok(_) => return Err(fail("Cannot undo while a Git operation is active")),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let status = git(&[
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
    ])?;
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
    let current = git(&["rev-parse", "--verify", "HEAD"])?
        .stdout
        .trim()
        .to_string();
    if current != head {
        return Err(fail("Cannot undo: HEAD changed while reading reflog"));
    }
    git(&["cat-file", "-e", &format!("{target}^{{commit}}")])?;
    if !ignored_paths.is_empty() {
        // reset --keep can overwrite ignored content. Check both prefix
        // directions: a target file can replace a directory, or need a
        // directory where an ignored file currently exists. Matching ignored
        // directories are treated as occupied without walking their trees.
        let listing = git(&["ls-tree", "-r", "-z", "--name-only", &target])?.stdout;
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

pub fn undo(
    git: GitRunner,
    git_with_env: GitEnvRunner,
    preview: &UndoPreview,
) -> Result<(), GitError> {
    let current = get_undo_preview(git)?;
    if current != *preview {
        return Err(fail("Cannot undo: preview is stale; refresh and try again"));
    }
    // reset has no expected-old-HEAD option. External Git commands can race
    // after validation; callers must not run concurrent repository mutations.
    git_with_env(
        &[
            "reset",
            "--keep",
            "--no-recurse-submodules",
            &current.target,
        ],
        &[("GIT_REFLOG_ACTION", "tuig undo")],
    )?;
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

    fn git(dir: &Path, args: &[&str]) -> String {
        run_git(args, Some(dir))
            .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
            .stdout
            .trim()
            .to_string()
    }

    fn commit(dir: &Path, content: &str) -> String {
        std::fs::write(dir.join("file"), content).unwrap();
        git(dir, &["add", "file"]);
        git(dir, &["commit", "-m", content.trim()]);
        git(dir, &["rev-parse", "HEAD"])
    }

    fn fixture() -> Fixture {
        let dir = temp_repo();
        git(dir.path(), &["config", "user.name", "Test"]);
        git(dir.path(), &["config", "user.email", "test@example.com"]);
        let initial = commit(dir.path(), "initial\n");
        let repo = GitRepositoryService::open(dir.path()).unwrap();
        Fixture { dir, repo, initial }
    }

    fn message<T>(result: Result<T, GitError>) -> String {
        result.err().expect("expected an error").to_string()
    }

    #[test]
    fn undo_restores_the_previous_tip_and_tree() {
        for operation in ["commit", "amend", "reset", "merge"] {
            let f = fixture();
            let root = f.dir.path();
            let mut target = f.initial.clone();
            let mut content = "initial\n";
            match operation {
                "commit" => {
                    commit(root, "new\n");
                }
                "amend" => {
                    std::fs::write(root.join("file"), "amended\n").unwrap();
                    git(root, &["add", "file"]);
                    git(root, &["commit", "--amend", "-m", "amended"]);
                }
                "reset" => {
                    target = commit(root, "new\n");
                    content = "new\n";
                    git(root, &["reset", "--hard", &f.initial]);
                }
                _ => {
                    git(root, &["switch", "-c", "topic"]);
                    commit(root, "topic\n");
                    git(root, &["switch", "main"]);
                    git(root, &["merge", "--no-ff", "topic", "-m", "merge"]);
                }
            }
            let preview = f.repo.get_undo_preview().unwrap();
            assert_eq!(preview.target, target, "{operation}");
            assert_eq!(preview.reflog_token.len(), 64);
            f.repo.undo(&preview).unwrap();
            assert_eq!(git(root, &["rev-parse", "HEAD"]), target, "{operation}");
            assert_eq!(std::fs::read_to_string(root.join("file")).unwrap(), content);
            assert_eq!(git(root, &["status", "--porcelain"]), "");
            assert!(message(f.repo.get_undo_preview()).contains("previous undo"));
        }
    }

    #[test]
    fn dirty_tracked_staged_and_untracked_data_are_preserved() {
        let f = fixture();
        let root = f.dir.path();
        commit(root, "new\n");
        let preview = f.repo.get_undo_preview().unwrap();
        std::fs::write(root.join("file"), "staged\n").unwrap();
        git(root, &["add", "file"]);
        std::fs::write(root.join("file"), "unstaged\n").unwrap();
        std::fs::write(root.join("untracked"), "keep\n").unwrap();
        let before = git(root, &["status", "--porcelain"]);

        assert!(message(f.repo.undo(&preview)).contains("tracked changes or untracked"));

        assert_eq!(git(root, &["status", "--porcelain"]), before);
        assert_eq!(
            std::fs::read_to_string(root.join("file")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("untracked")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn undo_refuses_ignored_prefix_collisions() {
        for target_directory in [false, true] {
            let f = fixture();
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
            git(root, &["add", "artifact"]);
            git(root, &["commit", "-m", "track artifact"]);
            git(root, &["rm", "-r", "artifact"]);
            std::fs::write(root.join(".gitignore"), "artifact\n").unwrap();
            git(root, &["add", ".gitignore"]);
            git(root, &["commit", "-m", "ignore artifact"]);
            let preview = f.repo.get_undo_preview().unwrap();
            if !target_directory {
                std::fs::create_dir(root.join("artifact")).unwrap();
            }
            let precious = root.join(if target_directory {
                "artifact"
            } else {
                "artifact/precious"
            });
            std::fs::write(&precious, "keep\n").unwrap();

            assert!(message(f.repo.undo(&preview)).contains("overlap ignored"));

            assert_eq!(std::fs::read_to_string(&precious).unwrap(), "keep\n");
            assert_eq!(git(root, &["rev-parse", "HEAD"]), preview.head);
        }
    }

    #[test]
    fn undo_allows_unrelated_ignored_build_directories() {
        let f = fixture();
        let root = f.dir.path();
        std::fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
        git(root, &["add", ".gitignore"]);
        commit(root, "new\n");
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/dependency"), "keep\n").unwrap();

        f.repo.undo(&f.repo.get_undo_preview().unwrap()).unwrap();

        assert_eq!(git(root, &["rev-parse", "HEAD"]), f.initial);
        assert_eq!(
            std::fs::read_to_string(root.join("node_modules/dependency")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn same_hash_reflog_entries_and_modified_previews_are_stale() {
        let f = fixture();
        let root = f.dir.path();
        commit(root, "new\n");
        let preview = f.repo.get_undo_preview().unwrap();
        let tampered = UndoPreview {
            target: preview.head.clone(),
            ..preview.clone()
        };
        assert!(message(f.repo.undo(&tampered)).contains("stale"));
        git(root, &["reset", "--hard", "HEAD"]);
        assert!(message(f.repo.get_undo_preview()).contains("did not move HEAD"));
        assert!(message(f.repo.undo(&preview)).contains("did not move HEAD"));
        git(root, &["reset", "--hard", &preview.target]);
        git(root, &["reset", "--hard", &preview.head]);
        assert!(message(f.repo.undo(&preview)).contains("stale"));
    }

    #[test]
    fn cherry_pick_checkout_detached_head_and_active_operations_are_refused() {
        let f = fixture();
        let root = f.dir.path();
        git(root, &["switch", "-c", "topic"]);
        let picked = commit(root, "picked\n");
        git(root, &["switch", "main"]);
        git(root, &["cherry-pick", &picked]);
        assert!(message(f.repo.get_undo_preview()).contains("unsupported"));

        commit(root, "new\n");
        git(root, &["switch", "-c", "other"]);
        assert!(message(f.repo.get_undo_preview()).contains("unsupported"));
        git(root, &["checkout", "--detach"]);
        assert!(message(f.repo.get_undo_preview()).contains("detached"));
        git(root, &["switch", "main"]);
        let head = git(root, &["rev-parse", "HEAD"]);
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
        );
        assert!(message(f.repo.get_undo_preview()).contains("unsupported"));
        std::fs::create_dir(root.join(".git/rebase-merge")).unwrap();
        assert!(message(f.repo.get_undo_preview()).contains("operation is active"));
    }
}
