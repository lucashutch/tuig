use std::path::Path;

use super::*;
use crate::process::{GitCommandAbortedError, GitOutputLimitError, run_git};
use crate::test_util::{TempDir, temp_repo};
use crate::types::SubmoduleState;

async fn git(dir: &Path, args: &[&str]) -> String {
    run_git(args, Some(dir))
        .await
        .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
        .stdout
        .trim()
        .to_string()
}

async fn git_env(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
    let mut options = RunOptions::in_dir(dir);
    options.env = env
        .iter()
        .map(|(k, v)| (k.to_string(), Some(v.to_string())))
        .collect();
    run_git_with(args, &options)
        .await
        .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
        .stdout
        .trim()
        .to_string()
}

/// A repository on `main` with a committer identity.
async fn repo_dir() -> TempDir {
    let dir = temp_repo().await;
    git(dir.path(), &["config", "user.name", "Test User"]).await;
    git(dir.path(), &["config", "user.email", "test@example.com"]).await;
    dir
}

fn write(dir: &Path, name: &str, body: &str) {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, body).unwrap();
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

fn paths(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

async fn open(dir: &TempDir) -> GitRepositoryService {
    GitRepositoryService::open(dir.path()).await.unwrap()
}

/// Write, stage, and commit one file through the service.
async fn commit_file(
    repo: &GitRepositoryService,
    dir: &Path,
    name: &str,
    body: &str,
    message: &str,
) {
    write(dir, name, body);
    repo.stage(&paths(&[name])).await.unwrap();
    repo.commit(message).await.unwrap();
}

fn subjects(commits: &[Commit]) -> Vec<&str> {
    commits.iter().map(|c| c.subject.as_str()).collect()
}

fn error_text<T>(result: Result<T>) -> String {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(error) => error.to_string(),
    }
}

#[tokio::test]
async fn working_status_lists_files_inside_untracked_directories() {
    let dir = temp_repo().await;
    write(dir.path(), ".claude/notes/a.md", "hello\n");
    write(dir.path(), ".claude/empty.txt", "");
    let repo = open(&dir).await;

    let mut listed: Vec<String> = repo
        .working_status()
        .await
        .unwrap()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect();
    listed.sort();

    assert_eq!(listed, [".claude/empty.txt", ".claude/notes/a.md"]);
}

#[tokio::test]
async fn linked_worktrees_are_hidden_from_changes_and_know_their_main_checkout() {
    let dir = repo_dir().await;
    git(dir.path(), &["commit", "--allow-empty", "-m", "init"]).await;
    git(
        dir.path(),
        &[
            "worktree",
            "add",
            "-b",
            "feature",
            ".claude/worktrees/feature",
        ],
    )
    .await;
    git(dir.path(), &["init", "-b", "main", "vendor/other"]).await;
    let repo = open(&dir).await;

    let working: Vec<String> = repo
        .working_status()
        .await
        .unwrap()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect();
    let snapshot: Vec<String> = repo
        .snapshot(DEFAULT_HISTORY_PAGE)
        .await
        .unwrap()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect();

    assert_eq!(working, ["vendor/other/"]);
    assert_eq!(snapshot, ["vendor/other/"]);
    assert_eq!(repo.main_worktree(), None);
    let linked = GitRepositoryService::open(dir.path().join(".claude/worktrees/feature"))
        .await
        .unwrap();
    assert_eq!(linked.main_worktree(), Some(repo.root()));
}

#[tokio::test]
async fn discard_removes_selected_untracked_content_and_keeps_staged_content() {
    let dir = repo_dir().await;
    let root = dir.path();
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "tracked.txt"]).await;
    git(root, &["commit", "-m", "initial"]).await;
    write(root, "tracked.txt", "staged\n");
    git(root, &["add", "tracked.txt"]).await;
    write(root, "tracked.txt", "unstaged\n");
    write(root, "new-dir/new.txt", "new\n");
    write(root, ".gitignore", "ignored.txt\nnew-dir/ignored/\n");
    write(root, "ignored.txt", "keep\n");
    write(root, "new-dir/ignored/keep.txt", "keep\n");

    open(&dir)
        .await
        .discard(&paths(&["tracked.txt", "new-dir"]))
        .await
        .unwrap();

    assert_eq!(read(root, "tracked.txt"), "staged\n");
    assert!(!root.join("new-dir/new.txt").exists());
    assert!(root.join("new-dir/ignored/keep.txt").exists());
    assert!(root.join("ignored.txt").exists());
    assert!(
        git(root, &["diff", "--cached", "--", "tracked.txt"])
            .await
            .contains("staged")
    );
}

#[tokio::test]
async fn discard_treats_wildcard_paths_literally() {
    let dir = repo_dir().await;
    let root = dir.path();
    for name in ["tracked*.txt", "tracked-neighbor.txt"] {
        write(root, name, "base\n");
    }
    git(root, &["add", "--all"]).await;
    git(root, &["commit", "-m", "initial"]).await;
    write(root, "tracked*.txt", "discard\n");
    write(root, "tracked-neighbor.txt", "keep\n");
    write(root, "untracked?.txt", "discard\n");
    write(root, "untracked1.txt", "keep\n");
    write(root, "bracket[1].txt", "discard\n");
    write(root, "bracket1.txt", "keep\n");
    write(root, ":(glob)magic", "discard\n");
    write(root, "magic", "keep\n");

    open(&dir)
        .await
        .discard(&paths(&[
            "tracked*.txt",
            "untracked?.txt",
            "bracket[1].txt",
            ":(glob)magic",
        ]))
        .await
        .unwrap();

    assert_eq!(read(root, "tracked*.txt"), "base\n");
    assert_eq!(read(root, "tracked-neighbor.txt"), "keep\n");
    for name in ["untracked?.txt", "bracket[1].txt", ":(glob)magic"] {
        assert!(!root.join(name).exists(), "{name} should be gone");
    }
    for name in ["untracked1.txt", "bracket1.txt", "magic"] {
        assert!(root.join(name).exists(), "{name} should stay");
    }
}

#[tokio::test]
async fn remote_deletion_removes_the_server_branch_but_keeps_the_local_copy() {
    let dir = repo_dir().await;
    let remote = TempDir::new("tuig-delete-remote");
    git(remote.path(), &["init", "--bare"]).await;
    git(dir.path(), &["commit", "--allow-empty", "-m", "initial"]).await;
    git(
        dir.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    )
    .await;
    git(dir.path(), &["branch", "feature/topic"]).await;
    git(dir.path(), &["push", "-u", "origin", "feature/topic"]).await;

    open(&dir)
        .await
        .delete_remote_branch("origin/feature/topic", None)
        .await
        .unwrap();

    assert_eq!(
        git(
            remote.path(),
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/feature/topic"
            ]
        )
        .await,
        ""
    );
    git(
        dir.path(),
        &["show-ref", "--verify", "refs/heads/feature/topic"],
    )
    .await;
}

#[tokio::test]
async fn opening_a_non_repository_reports_a_launch_error() {
    let dir = TempDir::new("tuig-not-repo");
    let shown = dir.path().display().to_string();
    let error = GitRepositoryService::open(dir.path()).await.err().unwrap();
    assert!(matches!(error, GitError::NotRepository(_)));
    assert_eq!(
        error.to_string(),
        format!(
            "No Git repository found at \"{shown}\".\n\nHint: Run tuig from inside a Git repository or pass the path to one."
        )
    );
}

#[tokio::test]
async fn stages_commits_and_reports_an_odd_filename() {
    let dir = repo_dir().await;
    let root = dir.path();
    write(root, "odd name.txt", "one\n");
    let repo = open(&dir).await;
    let request = |path: &str| DiffRequest {
        path: Some(path.into()),
        ..DiffRequest::default()
    };
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().files[0].path,
        "odd name.txt"
    );
    assert!(
        repo.diff(&request("odd name.txt"))
            .await
            .unwrap()
            .contains("+one")
    );
    repo.stage(&paths(&["odd name.txt"])).await.unwrap();
    repo.commit("initial").await.unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().commits[0].subject,
        "initial"
    );
    let files = repo.commit_files("HEAD", None).await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(
        (files[0].path.as_str(), files[0].state),
        ("odd name.txt", FileState::Added)
    );

    write(root, "odd name.txt", "one\ntwo\n");
    assert!(
        repo.diff(&request("odd name.txt"))
            .await
            .unwrap()
            .contains("+two")
    );
    repo.stage(&paths(&["odd name.txt"])).await.unwrap();
    repo.commit("second").await.unwrap();
    let commits = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().commits;
    assert_eq!(commits.len(), 2);
    assert!(
        commits
            .iter()
            .all(|c| c.sha.len() == 40 && c.sha.bytes().all(|b| b.is_ascii_hexdigit()))
    );
    let first = repo.commit_files(&commits[1].sha, None).await.unwrap();
    assert_eq!(first[0].state, FileState::Added);
    let between = repo
        .commit_files(&commits[0].sha, Some(&commits[1].sha))
        .await
        .unwrap();
    assert_eq!(between.len(), 1);
    assert_eq!(between[0].state, FileState::Modified);
    let comparison = DiffRequest {
        base: Some(commits[1].sha.clone()),
        target: Some(commits[0].sha.clone()),
        ..DiffRequest::default()
    };
    assert!(repo.diff(&comparison).await.unwrap().contains("+two"));

    write(root, "odd name.txt", "stashed\n");
    repo.stash(Some("visible stash"), false).await.unwrap();
    let stash = &repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().stashes[0];
    assert_eq!(stash.reference, "stash@{0}");
    assert!(stash.subject.contains("visible stash"));
}

#[tokio::test]
async fn file_history_follows_a_renamed_option_like_path_from_an_optional_ref() {
    let dir = repo_dir().await;
    let root = dir.path();
    write(root, "old name.txt", "one\n");
    git(root, &["add", "--", "old name.txt"]).await;
    git(root, &["commit", "-m", "add file"]).await;
    let added = git(root, &["rev-parse", "HEAD"]).await;
    git(root, &["mv", "--", "old name.txt", "--new name.txt"]).await;
    git(root, &["commit", "-m", "rename file"]).await;
    let renamed = git(root, &["rev-parse", "HEAD"]).await;
    write(root, "--new name.txt", "one\ntwo\n");
    git(root, &["add", "--", "--new name.txt"]).await;
    git(root, &["commit", "-m", "edit renamed file"]).await;

    let repo = open(&dir).await;
    let history = repo.file_history("--new name.txt", None).await.unwrap();
    assert_eq!(
        subjects(&history),
        ["edit renamed file", "rename file", "add file"]
    );
    assert_eq!(history[2].sha, added);
    assert_eq!(history[2].author, "Test User");
    assert_eq!(history[2].committer, "Test User");
    let from_ref = repo
        .file_history("--new name.txt", Some(&renamed))
        .await
        .unwrap();
    assert_eq!(subjects(&from_ref), ["rename file", "add file"]);
    assert_eq!(
        error_text(repo.file_history("--new name.txt", Some("--all")).await),
        "A commit is required"
    );
}

#[tokio::test]
async fn line_blame_reports_commit_and_original_location_across_edits_and_a_rename() {
    let dir = repo_dir().await;
    let root = dir.path();
    write(root, "before name.txt", "alpha\nbeta\n");
    git(root, &["add", "--", "before name.txt"]).await;
    git(root, &["commit", "-m", "write beta"]).await;
    let source = git(root, &["rev-parse", "HEAD"]).await;
    git(root, &["mv", "--", "before name.txt", "--after name.txt"]).await;
    write(root, "--after name.txt", "intro\nalpha\nbeta\n");
    git(root, &["add", "--", "--after name.txt"]).await;
    git(root, &["commit", "-m", "move lines"]).await;
    let moved = git(root, &["rev-parse", "HEAD"]).await;

    let repo = open(&dir).await;
    let blame = repo.blame_line("--after name.txt", 3, None).await.unwrap();
    assert_eq!(blame.commit.sha, source);
    assert_eq!(blame.commit.subject, "write beta");
    assert_eq!(blame.commit.author, "Test User");
    assert_eq!(blame.original_path, "before name.txt");
    assert_eq!((blame.original_line, blame.final_line), (2, 3));
    assert_eq!(blame.final_path, "--after name.txt");

    let at_moved = repo
        .blame_line("--after name.txt", 1, Some(&moved))
        .await
        .unwrap();
    assert_eq!(at_moved.commit.sha, moved);
    assert_eq!(at_moved.commit.subject, "move lines");
    assert_eq!((at_moved.original_line, at_moved.final_line), (1, 1));

    let lines = repo
        .line_history("--after name.txt", 3, None)
        .await
        .unwrap();
    assert_eq!(subjects(&lines), ["write beta"]);
    let zero = repo
        .blame_line("--after name.txt", 0, None)
        .await
        .err()
        .unwrap();
    // A rejected argument is its own variant, so callers do not match on an I/O error kind.
    assert!(
        matches!(&zero, GitError::Invalid(message) if message == "A positive 1-based line number is required")
    );
    assert_eq!(
        zero.to_string(),
        "A positive 1-based line number is required"
    );
    assert_eq!(
        error_text(
            repo.blame_line("--after name.txt", 1, Some("--contents=/etc/passwd"))
                .await
        ),
        "A commit is required"
    );
}

#[tokio::test]
async fn quoted_blame_paths_decode_escapes_and_octal_bytes() {
    assert_eq!(parse_git_quoted_path("plain"), "plain");
    assert_eq!(parse_git_quoted_path(r#""a\tb\"c\\d""#), "a\tb\"c\\d");
    assert_eq!(parse_git_quoted_path(r#""caf\303\251""#), "café");
    assert_eq!(parse_git_quoted_path(r#""\q""#), "q");
}

#[tokio::test]
async fn snapshot_keeps_stash_internal_commits_out_of_history() {
    let dir = repo_dir().await;
    let root = dir.path();
    write(root, "file", "base\n");
    git(root, &["add", "file"]).await;
    git(root, &["commit", "-m", "base"]).await;
    let repo = open(&dir).await;

    write(root, "file", "staged change\n");
    repo.stage(&paths(&["file"])).await.unwrap();
    write(root, "file", "worktree change\n");
    write(root, "untracked.txt", "untracked\n");
    repo.stash(Some("history stash"), true).await.unwrap();

    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap();
    assert_eq!(snapshot.stashes.len(), 1);
    // One row per stash: the WIP tip, without its internal index/untracked rows.
    assert_eq!(snapshot.commits.len(), 2);
    assert!(snapshot.commits[0].subject.contains("history stash"));
    assert_eq!(snapshot.commits[1].subject, "base");
    assert!(
        snapshot.commits[0]
            .decorations
            .iter()
            .any(|d| d == "refs/stash")
    );
    assert_eq!(snapshot.commits[0].parents.len(), 1);
}

#[tokio::test]
async fn stash_tip_pages_with_history_instead_of_shifting_it() {
    let dir = repo_dir().await;
    let repo = open(&dir).await;
    for name in ["one", "two", "three"] {
        commit_file(
            &repo,
            dir.path(),
            &format!("{name}.txt"),
            &format!("{name}\n"),
            name,
        )
        .await;
    }
    write(dir.path(), "three.txt", "stashed\n");
    repo.stash(Some("paged stash"), false).await.unwrap();

    let first = repo.commit_page(2, 0).await.unwrap();
    assert!(first.commits[0].subject.contains("paged stash"));
    assert_eq!(first.commits[1].subject, "three");
    assert_eq!(first.commits.len(), 2);
    assert!(!first.complete);
    let second = repo.commit_page(3, 1).await.unwrap();
    assert_eq!(subjects(&second.commits), ["three", "two", "one"]);
    assert!(second.complete);
}

#[tokio::test]
async fn snapshot_pages_stash_rows_like_commit_page_and_starts_one_walk() {
    let dir = repo_dir().await;
    let repo = open(&dir).await;
    for name in ["one", "two", "three"] {
        commit_file(
            &repo,
            dir.path(),
            &format!("{name}.txt"),
            &format!("{name}\n"),
            name,
        )
        .await;
    }
    write(dir.path(), "three.txt", "stashed\n");
    repo.stash(Some("snap stash"), false).await.unwrap();

    let before = repo.walk_starts().await;
    let snapshot = repo.snapshot(2).await.unwrap();
    assert_eq!(repo.walk_starts().await, before + 1);
    assert_eq!(snapshot.stashes.len(), 1);
    assert_eq!(snapshot.commits.len(), 2);
    assert!(snapshot.commits[0].subject.contains("snap stash"));
    assert_eq!(snapshot.commits[1].subject, "three");
    assert!(!snapshot.commits_complete);

    let all = repo.snapshot(10).await.unwrap();
    assert!(all.commits_complete);
    assert_eq!(all.commits.len(), 4);

    // Read-only metadata calls must not drop the walk an unchanged refresh reuses.
    let starts = repo.walk_starts().await;
    repo.refresh_snapshot(&all, 10).await.unwrap();
    assert_eq!(repo.walk_starts().await, starts);
}

#[tokio::test]
async fn shows_a_stash_at_its_creation_time_in_history() {
    let dir = repo_dir().await;
    let root = dir.path();
    let at = |date: &'static str| [("GIT_AUTHOR_DATE", date), ("GIT_COMMITTER_DATE", date)];
    write(root, "file", "base\n");
    git(root, &["add", "file"]).await;
    git_env(root, &["commit", "-m", "base"], &at("2026-01-01T00:00:00Z")).await;
    write(root, "file", "stashed\n");
    git_env(
        root,
        &["stash", "push", "-m", "middle stash"],
        &at("2026-01-02T00:00:00Z"),
    )
    .await;
    write(root, "newer", "newer\n");
    git(root, &["add", "newer"]).await;
    git_env(
        root,
        &["commit", "-m", "newer"],
        &at("2026-01-03T00:00:00Z"),
    )
    .await;

    let commits = open(&dir)
        .await
        .snapshot(DEFAULT_HISTORY_PAGE)
        .await
        .unwrap()
        .commits;
    assert_eq!(commits.len(), 3);
    assert_eq!(commits[0].subject, "newer");
    assert!(commits[1].subject.contains("middle stash"));
    assert_eq!(commits[2].subject, "base");
}

#[tokio::test]
async fn diff_enforces_byte_limits_and_preserves_cancellation_errors() {
    let dir = temp_repo().await;
    write(dir.path(), "large.txt", &"x".repeat(100_000));
    let repo = open(&dir).await;
    let limited = repo
        .diff(&DiffRequest {
            path: Some("large.txt".into()),
            max_bytes: Some(100),
            ..DiffRequest::default()
        })
        .await
        .err()
        .unwrap();
    match limited {
        GitError::OutputLimit(GitOutputLimitError { limit_bytes, .. }) => {
            assert_eq!(limit_bytes, 100)
        }
        other => panic!("expected an output limit error, got {other:?}"),
    }
    let token = CancelToken::new();
    token.cancel();
    let cancelled = repo
        .diff(&DiffRequest {
            path: Some("large.txt".into()),
            cancel: Some(token),
            ..DiffRequest::default()
        })
        .await
        .err()
        .unwrap();
    assert!(matches!(
        cancelled,
        GitError::Aborted(GitCommandAbortedError { .. })
    ));
}

#[tokio::test]
async fn diff_of_an_untracked_file_uses_no_index_and_tracked_clean_file_is_empty() {
    let dir = repo_dir().await;
    let root = dir.path();
    write(root, "tracked.txt", "one\n");
    git(root, &["add", "."]).await;
    git(root, &["commit", "-m", "base"]).await;
    write(root, "new.txt", "fresh\n");
    let repo = open(&dir).await;
    let request = |path: &str| DiffRequest {
        path: Some(path.into()),
        ..DiffRequest::default()
    };
    let patch = repo.diff(&request("new.txt")).await.unwrap();
    assert!(patch.contains("new file mode"));
    assert!(patch.contains("+fresh"));
    assert_eq!(repo.diff(&request("tracked.txt")).await.unwrap(), "");
}

#[tokio::test]
async fn refresh_reuses_history_for_worktree_edits_and_reloads_moved_refs() {
    let dir = repo_dir().await;
    let root = dir.path();
    write(root, "file", "one\n");
    git(root, &["add", "file"]).await;
    git(root, &["commit", "-m", "one"]).await;
    let repo = open(&dir).await;
    let first = repo.snapshot(1).await.unwrap();
    let starts = repo.walk_starts().await;

    write(root, "file", "two\n");
    let worktree_refresh = repo.refresh_snapshot(&first, 1).await.unwrap();
    assert_eq!(worktree_refresh.commits, first.commits);
    assert_eq!(worktree_refresh.files.len(), 1);
    assert_eq!(
        repo.walk_starts().await,
        starts,
        "worktree edits reuse history"
    );

    git(root, &["tag", "new-tag"]).await;
    let ref_refresh = repo.refresh_snapshot(&worktree_refresh, 1).await.unwrap();
    assert_eq!(
        repo.walk_starts().await,
        starts + 1,
        "a new tag reloads history"
    );
    assert!(
        ref_refresh.commits[0]
            .decorations
            .iter()
            .any(|d| d.contains("new-tag"))
    );
    assert!(
        !ref_refresh
            .branches
            .iter()
            .any(|r| r.full_name.contains("tags/"))
    );
}

#[tokio::test]
async fn poll_notices_unborn_branch_creation_and_detached_head_movement() {
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    let empty = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap();
    assert_eq!(empty.branch.as_deref(), Some("main"));
    assert!(empty.commits.is_empty());

    git(root, &["commit", "--allow-empty", "-m", "one"]).await;
    let first = repo
        .refresh_snapshot(&empty, DEFAULT_HISTORY_PAGE)
        .await
        .unwrap();
    assert_eq!(first.commits.len(), 1);
    git(root, &["commit", "--allow-empty", "-m", "two"]).await;
    let second = repo
        .refresh_snapshot(&first, DEFAULT_HISTORY_PAGE)
        .await
        .unwrap();
    assert_eq!(second.commits.len(), 2);

    git(root, &["checkout", "--detach", "HEAD~1"]).await;
    let before = repo.walk_starts().await;
    let detached = repo
        .refresh_snapshot(&second, DEFAULT_HISTORY_PAGE)
        .await
        .unwrap();
    assert_eq!(detached.branch, None);
    assert_eq!(repo.walk_starts().await, before + 1);
    let head = detached
        .commits
        .iter()
        .find(|c| c.decorations.iter().any(|d| d == "HEAD"))
        .unwrap();
    assert_eq!(head.sha, first.commits[0].sha);

    let before = repo.walk_starts().await;
    repo.refresh_snapshot(&detached, DEFAULT_HISTORY_PAGE)
        .await
        .unwrap();
    assert_eq!(repo.walk_starts().await, before);
}

#[tokio::test]
async fn snapshot_enriches_recursively_reported_submodules_with_gitmodules_names() {
    let source = repo_dir().await;
    write(source.path(), "readme", "source\n");
    git(source.path(), &["add", "readme"]).await;
    git(source.path(), &["commit", "-m", "source"]).await;
    let dir = repo_dir().await;
    let root = dir.path();
    git(
        root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            source.path().to_str().unwrap(),
            "modules/nested path",
        ],
    )
    .await;
    write(
        root,
        ".gitmodules",
        &format!(
            "[submodule \"library repository\"]\n\tpath = modules/nested path\n\turl = {}\n",
            source.path().display()
        ),
    );

    let repo = open(&dir).await;
    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap();
    assert_eq!(snapshot.submodules.len(), 1);
    assert_eq!(snapshot.submodules[0].path, "modules/nested path");
    assert_eq!(
        snapshot.submodules[0].name.as_deref(),
        Some("library repository")
    );
    assert_ne!(snapshot.submodules[0].state, SubmoduleState::Conflicted);
    repo.sync_submodule("modules/nested path").await.unwrap();
    repo.update_submodule("modules/nested path", true)
        .await
        .unwrap();
    assert_eq!(read(root, "modules/nested path/readme"), "source\n");
    assert_eq!(
        error_text(repo.update_submodule("  ", false).await),
        "A submodule path is required"
    );
}

#[tokio::test]
async fn fetch_prunes_remote_tracking_branches_deleted_on_the_remote() {
    let dir = repo_dir().await;
    let root = dir.path();
    write(root, "file", "initial\n");
    git(root, &["add", "file"]).await;
    git(root, &["commit", "-m", "initial"]).await;
    let remote = TempDir::new("tuig-fetch-remote");
    git(
        root,
        &[
            "clone",
            "--bare",
            root.to_str().unwrap(),
            remote.path().to_str().unwrap(),
        ],
    )
    .await;
    git(
        root,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    )
    .await;
    git(root, &["switch", "-c", "topic"]).await;
    git(root, &["push", "-u", "origin", "topic"]).await;
    let repo = open(&dir).await;
    let has_topic = async |repo: &GitRepositoryService| {
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .await
            .unwrap()
            .branches
            .iter()
            .any(|r| r.name == "origin/topic")
    };
    assert!(has_topic(&repo).await);
    git(root, &["push", "origin", "--delete", "topic"]).await;
    repo.fetch(None, None).await.unwrap();
    assert!(!has_topic(&repo).await);
    assert!(!repo.auth_blocked());
}

#[tokio::test]
async fn amends_head_using_only_staged_changes() {
    let dir = repo_dir().await;
    let repo = open(&dir).await;
    commit_file(&repo, dir.path(), "staged.txt", "one\n", "initial").await;
    write(dir.path(), "staged.txt", "two\n");
    repo.stage(&paths(&["staged.txt"])).await.unwrap();
    write(dir.path(), "unstaged.txt", "leave me\n");
    repo.amend_commit("amended\n\nfull message").await.unwrap();

    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap();
    assert_eq!(snapshot.commits[0].subject, "amended");
    assert_eq!(snapshot.commits[0].body.as_deref(), Some("full message"));
    assert_eq!(read(dir.path(), "unstaged.txt"), "leave me\n");
    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].path, "unstaged.txt");
    assert!(snapshot.files[0].unstaged);
}

#[tokio::test]
async fn rewords_a_non_head_commit_and_refuses_a_dirty_worktree() {
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    commit_file(&repo, root, "a", "a\n", "first").await;
    commit_file(&repo, root, "b", "b\n", "second").await;
    let first = repo
        .snapshot(DEFAULT_HISTORY_PAGE)
        .await
        .unwrap()
        .commits
        .into_iter()
        .find(|c| c.subject == "first")
        .unwrap();
    write(root, "dirty", "x");
    assert!(error_text(repo.reword_commit(&first.sha, "renamed").await).contains("dirty worktree"));
    git(root, &["clean", "-fd"]).await;

    repo.reword_commit(&first.sha, "renamed\n\nnew body")
        .await
        .unwrap();

    let commits = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().commits;
    assert_eq!(subjects(&commits), ["second", "renamed"]);
    assert_eq!(commits[1].body.as_deref(), Some("new body"));
    assert_eq!(commits[1].author, "Test User");
    assert_eq!(read(root, "a"), "a\n");
    assert_eq!(read(root, "b"), "b\n");
}

#[tokio::test]
async fn rewords_root_and_head_commits_without_changing_their_trees() {
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    commit_file(&repo, root, "root.txt", "root\n", "root").await;
    let root_sha = git(root, &["rev-parse", "HEAD"]).await;
    let root_tree = git(root, &["show", "-s", "--format=%T", &root_sha]).await;
    repo.reword_commit(&root_sha, "renamed root").await.unwrap();
    assert_eq!(
        git(root, &["log", "-1", "--format=%s"]).await,
        "renamed root"
    );
    assert_eq!(
        git(root, &["show", "-s", "--format=%T", "HEAD"]).await,
        root_tree
    );

    commit_file(&repo, root, "head.txt", "head\n", "head").await;
    let head_sha = git(root, &["rev-parse", "HEAD"]).await;
    let head_tree = git(root, &["show", "-s", "--format=%T", "HEAD"]).await;
    repo.reword_commit(&head_sha, "renamed head").await.unwrap();
    assert_eq!(
        git(root, &["log", "-1", "--format=%s"]).await,
        "renamed head"
    );
    assert_eq!(
        git(root, &["show", "-s", "--format=%T", "HEAD"]).await,
        head_tree
    );
}

#[tokio::test]
async fn rewords_merge_commits_while_preserving_merge_topology_and_tree() {
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    commit_file(&repo, root, "base", "base\n", "base").await;
    repo.create_branch("topic", None, false).await.unwrap();
    repo.switch_branch("topic").await.unwrap();
    commit_file(&repo, root, "topic", "topic\n", "topic").await;
    repo.switch_branch("main").await.unwrap();
    commit_file(&repo, root, "main", "main\n", "main").await;
    git(root, &["merge", "--no-ff", "topic", "-m", "merge topic"]).await;
    let merge = git(root, &["rev-parse", "HEAD"]).await;
    let tree = git(root, &["show", "-s", "--format=%T", "HEAD"]).await;

    let files = repo.commit_files(&merge, None).await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(
        (files[0].path.as_str(), files[0].state),
        ("topic", FileState::Added)
    );
    let patch = repo
        .diff(&DiffRequest {
            commit: Some(merge.clone()),
            ..DiffRequest::default()
        })
        .await
        .unwrap();
    assert!(patch.contains("diff --git a/topic b/topic"));
    assert!(!patch.contains("diff --git a/main b/main"));

    repo.reword_commit(&merge, "renamed merge").await.unwrap();
    assert_eq!(
        git(root, &["log", "-1", "--format=%s"]).await,
        "renamed merge"
    );
    assert_eq!(
        git(root, &["show", "-s", "--format=%P", "HEAD"])
            .await
            .split(' ')
            .count(),
        2
    );
    assert_eq!(
        git(root, &["show", "-s", "--format=%T", "HEAD"]).await,
        tree
    );
}

#[tokio::test]
async fn reword_refuses_a_detached_head() {
    let dir = repo_dir().await;
    let repo = open(&dir).await;
    commit_file(&repo, dir.path(), "a", "a\n", "first").await;
    git(dir.path(), &["checkout", "--detach"]).await;
    assert_eq!(
        error_text(repo.reword_commit("HEAD", "x").await),
        "Cannot reword a commit while HEAD is detached"
    );
}

#[tokio::test]
async fn aborts_a_failed_reword_rebase_before_cleaning_up_helpers() {
    use std::os::unix::fs::PermissionsExt;
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    commit_file(&repo, root, "a", "a\n", "first").await;
    let sha = git(root, &["rev-parse", "HEAD"]).await;
    let hook = root.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(repo.reword_commit(&sha, "will fail").await.is_err());

    assert!(
        run_git(&["rev-parse", "--verify", "REBASE_HEAD"], Some(root))
            .await
            .is_err()
    );
    assert_eq!(git(root, &["status", "--porcelain"]).await, "");
}

#[tokio::test]
async fn checks_out_commits_and_branches_resets_and_rebases() {
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    commit_file(&repo, root, "a.txt", "one\n", "first").await;
    let first = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().commits[0]
        .sha
        .clone();
    commit_file(&repo, root, "b.txt", "two\n", "second").await;

    repo.checkout_commit(&first).await.unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().branch,
        None
    );
    repo.switch_branch("main").await.unwrap();

    // A bare clone stands in for a remote, so the remote-tracking checkout
    // path runs against a real ref.
    let remote = TempDir::new("tuig-remote");
    git(
        root,
        &[
            "clone",
            "--bare",
            root.to_str().unwrap(),
            remote.path().to_str().unwrap(),
        ],
    )
    .await;
    git(
        root,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    )
    .await;
    git(root, &["fetch", "origin"]).await;
    repo.checkout_remote_branch("copy", "origin/main", false)
        .await
        .unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .await
            .unwrap()
            .branch
            .as_deref(),
        Some("copy")
    );

    let head_subject = async || git(root, &["log", "-1", "--format=%s"]).await;
    repo.reset_to(&first, ResetMode::Hard).await.unwrap();
    assert_eq!(head_subject().await, "first");
    // `copy` now trails the remote, so the reset checkout must move it forward.
    repo.switch_branch("main").await.unwrap();
    repo.checkout_remote_branch("copy", "origin/main", true)
        .await
        .unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .await
            .unwrap()
            .branch
            .as_deref(),
        Some("copy")
    );
    assert_eq!(head_subject().await, "second");

    repo.reset_to(&first, ResetMode::Hard).await.unwrap();
    repo.rebase_onto("main").await.unwrap();
    assert_eq!(head_subject().await, "second");
}

#[tokio::test]
async fn creates_branches_and_tags_cherry_picks_and_manages_stashes() {
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    commit_file(&repo, root, "file", "base\n", "base").await;
    repo.create_branch("topic", None, true).await.unwrap();
    commit_file(&repo, root, "topic", "topic\n", "topic change").await;
    let topic_commit = git(root, &["rev-parse", "HEAD"]).await;
    repo.switch_branch("main").await.unwrap();
    repo.cherry_pick(&topic_commit).await.unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .await
            .unwrap()
            .branch
            .as_deref(),
        Some("main")
    );
    assert_eq!(read(root, "topic"), "topic\n");

    repo.create_tag("v1", Some(&topic_commit)).await.unwrap();
    assert_eq!(
        git(root, &["cat-file", "-t", "refs/tags/v1"]).await,
        "commit"
    );
    assert_eq!(git(root, &["rev-parse", "v1"]).await, topic_commit);
    repo.create_tag("head-tag", None).await.unwrap();
    assert_eq!(
        git(root, &["rev-parse", "head-tag"]).await,
        git(root, &["rev-parse", "HEAD"]).await
    );
    let remote = TempDir::new("tuig-tag-remote");
    git(remote.path(), &["init", "--bare"]).await;
    git(
        root,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    )
    .await;
    repo.push_tag("v1", Some("origin"), None).await.unwrap();
    assert_eq!(
        git(remote.path(), &["rev-parse", "refs/tags/v1"]).await,
        topic_commit
    );
    repo.delete_tag("head-tag").await.unwrap();
    assert!(
        run_git(&["show-ref", "--verify", "refs/tags/head-tag"], Some(root))
            .await
            .is_err()
    );

    write(root, "file", "stashed\n");
    repo.stash(Some("keep this"), false).await.unwrap();
    let stash_ref = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().stashes[0]
        .reference
        .clone();
    repo.apply_stash(&stash_ref, false).await.unwrap();
    assert_eq!(read(root, "file"), "stashed\n");
    repo.discard_all().await.unwrap();
    repo.pop_stash(&stash_ref).await.unwrap();
    assert_eq!(read(root, "file"), "stashed\n");
    assert!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .await
            .unwrap()
            .stashes
            .is_empty()
    );

    write(root, "file", "drop me\n");
    repo.stash(Some("drop this"), false).await.unwrap();
    let drop_ref = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().stashes[0]
        .reference
        .clone();
    repo.rename_stash(&drop_ref, "renamed stash").await.unwrap();
    let stashes = repo.snapshot(DEFAULT_HISTORY_PAGE).await.unwrap().stashes;
    assert!(stashes[0].subject.contains("renamed stash"));
    repo.drop_stash(&stashes[0].reference).await.unwrap();
    assert!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .await
            .unwrap()
            .stashes
            .is_empty()
    );
    // No backup refs remain after a successful rename.
    assert_eq!(git(root, &["for-each-ref", "refs/tuig"]).await, "");
}

#[tokio::test]
async fn sequential_pages_continue_one_walk_and_match_skipped_reads() {
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    for i in 0..12 {
        commit_file(
            &repo,
            root,
            &format!("f{i}.txt"),
            &format!("{i}\n"),
            &format!("c{i}"),
        )
        .await;
    }
    let all = repo.commit_page(50, 0).await.unwrap().commits;
    assert_eq!(all.len(), 12);
    // Page forward the way the history view does, overlapping by one commit.
    let mut paged: Vec<String> = Vec::new();
    let mut loaded = 0;
    loop {
        let page = repo.commit_page(3, loaded.max(1) - 1).await.unwrap();
        let skip_overlap = usize::from(loaded > 0);
        let fresh = &page.commits[skip_overlap..];
        paged.extend(fresh.iter().map(|c| c.sha.clone()));
        loaded += fresh.len();
        if page.complete {
            break;
        }
    }
    let expected: Vec<String> = all.iter().map(|c| c.sha.clone()).collect();
    assert_eq!(paged, expected);
    // A backwards jump the open walk cannot reach still reads the right page.
    let back = repo.commit_page(2, 1).await.unwrap();
    assert_eq!(back.commits[0].sha, all[1].sha);
    assert_eq!(back.commits[1].sha, all[2].sha);
    assert!(!back.complete);
    // Bodies survive record-by-record parsing, so a page is not just SHAs.
    assert_eq!(all[0].subject, "c11");

    // Refreshing restarts the walk against the new tip.
    commit_file(&repo, root, "extra.txt", "extra\n", "extra").await;
    let snapshot = repo.snapshot(4).await.unwrap();
    assert_eq!(snapshot.commits[0].subject, "extra");
    let next = repo.commit_page(4, 3).await.unwrap();
    assert_eq!(next.commits[0].sha, snapshot.commits[3].sha);
    assert_eq!(subjects(&next.commits), ["c9", "c8", "c7", "c6"]);
    repo.dispose().await;
    // Disposing only ends the walk; later pages still read correctly.
    assert_eq!(
        repo.commit_page(2, 0).await.unwrap().commits[0].subject,
        "extra"
    );
}

#[tokio::test]
async fn applies_and_discards_patches_through_stdin() {
    let dir = repo_dir().await;
    let root = dir.path();
    let repo = open(&dir).await;
    commit_file(&repo, root, "file", "one\n", "base").await;
    write(root, "file", "one\ntwo\n");
    let patch = git(root, &["diff"]).await + "\n";
    // Reset the working tree, then stage the change from the patch alone.
    git(root, &["checkout", "--", "file"]).await;
    repo.apply_patch(&patch, false).await.unwrap();
    assert!(git(root, &["diff", "--cached"]).await.contains("+two"));
    repo.apply_patch(&patch, true).await.unwrap();
    assert_eq!(git(root, &["diff", "--cached"]).await, "");
    // A patch that does not apply reports Git's error.
    assert!(matches!(
        repo.apply_patch("not a patch\n", false).await,
        Err(GitError::Command(_))
    ));

    write(root, "file", "one\ntwo\n");
    repo.discard_patch(&patch).await.unwrap();
    assert_eq!(read(root, "file"), "one\n");
}

#[tokio::test]
async fn remote_failures_without_credentials_block_background_fetch() {
    let dir = repo_dir().await;
    git(dir.path(), &["commit", "--allow-empty", "-m", "base"]).await;
    // A missing credential helper makes Git report that prompts are disabled.
    git(
        dir.path(),
        &["remote", "add", "origin", "https://127.0.0.1:1/nope.git"],
    )
    .await;
    let repo = open(&dir).await;
    let error = repo.fetch(Some("origin"), None).await.err().unwrap();
    // The connection fails before authentication, so this is a plain command
    // error and must not mark the repository as blocked.
    assert!(matches!(error, GitError::Command(_)));
    assert!(!repo.auth_blocked());
}

/// The background fetch skips a repository after a credential failure, and a successful remote operation lifts the
/// block (`authBlocked` in `src/git/repository.ts`). The ssh command is a script that rejects the key.
#[cfg(unix)]
#[tokio::test]
async fn a_credential_failure_blocks_background_fetch_until_a_fetch_succeeds() {
    use std::os::unix::fs::PermissionsExt;

    let dir = repo_dir().await;
    git(dir.path(), &["commit", "--allow-empty", "-m", "base"]).await;
    let tools = TempDir::new("tuig-ssh-stub");
    let ssh = tools.path().join("ssh");
    std::fs::write(
        &ssh,
        "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255\n",
    )
    .unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    git(
        dir.path(),
        &["config", "core.sshCommand", ssh.to_str().unwrap()],
    )
    .await;
    git(
        dir.path(),
        &[
            "remote",
            "add",
            "origin",
            "ssh://git@example.invalid/team/repo.git",
        ],
    )
    .await;
    let repo = open(&dir).await;
    assert!(!repo.auth_blocked());
    let error = repo.fetch(Some("origin"), None).await.err().unwrap();
    assert!(
        error
            .to_string()
            .contains("needs credentials for origin (example.invalid)"),
        "{error}"
    );
    assert!(repo.auth_blocked());

    // The same repository fetches from a reachable remote: the block ends.
    let origin = TempDir::new("tuig-origin");
    git(origin.path(), &["init", "--bare", "-b", "main"]).await;
    git(
        dir.path(),
        &[
            "remote",
            "set-url",
            "origin",
            origin.path().to_str().unwrap(),
        ],
    )
    .await;
    repo.fetch(Some("origin"), None).await.unwrap();
    assert!(!repo.auth_blocked());
}

#[tokio::test]
async fn early_history_matches_the_final_snapshot_and_keeps_refresh_reuse() {
    let dir = repo_dir().await;
    git(dir.path(), &["commit", "--allow-empty", "-m", "one"]).await;
    git(dir.path(), &["tag", "v1"]).await;
    git(dir.path(), &["commit", "--allow-empty", "-m", "two"]).await;
    git(dir.path(), &["branch", "side"]).await;
    std::fs::write(dir.path().join("dirty.txt"), "x").unwrap();
    let repo = open(&dir).await;

    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let snapshot = repo
        .snapshot_early(
            DEFAULT_HISTORY_PAGE,
            Box::new(move |head| sink.lock().unwrap().push(head)),
        )
        .await
        .unwrap();

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1, "early history is reported once");
    let early = &seen[0];
    assert_eq!(early.commits, snapshot.commits);
    assert_eq!(early.commits_complete, snapshot.commits_complete);
    assert_eq!(early.branches, snapshot.branches);
    assert_eq!(early.branch, snapshot.branch);
    assert_eq!(early.head_sha, snapshot.head_sha);
    assert_eq!(early.branch.as_deref(), Some("main"));
    assert!(snapshot.files.iter().any(|file| file.path == "dirty.txt"));

    // The signature of an early snapshot lets a refresh reuse its commits.
    let refreshed = repo
        .refresh_snapshot(&snapshot, DEFAULT_HISTORY_PAGE)
        .await
        .unwrap();
    assert_eq!(refreshed.commits, snapshot.commits);
}

#[tokio::test]
async fn early_history_reports_a_detached_head() {
    let dir = repo_dir().await;
    git(dir.path(), &["commit", "--allow-empty", "-m", "one"]).await;
    git(dir.path(), &["commit", "--allow-empty", "-m", "two"]).await;
    git(dir.path(), &["checkout", "--detach", "HEAD~1"]).await;
    let repo = open(&dir).await;

    let seen = std::sync::Arc::new(Mutex::new(None));
    let sink = seen.clone();
    let snapshot = repo
        .snapshot_early(
            DEFAULT_HISTORY_PAGE,
            Box::new(move |head| *sink.lock().unwrap() = Some(head)),
        )
        .await
        .unwrap();

    let early = seen.lock().unwrap().take().unwrap();
    assert_eq!(early.branch, None);
    assert_eq!(early.head_sha, snapshot.head_sha);
    assert!(early.head_sha.is_some());
}

/// Hides the repository so any Git process fails. A cache hit still answers.
fn hide_git_dir(dir: &Path) {
    std::fs::rename(dir.join(".git"), dir.join(".git-hidden")).unwrap();
}

fn commit_request(sha: &str, path: &str) -> DiffRequest {
    DiffRequest {
        path: Some(path.into()),
        commit: Some(sha.into()),
        context: Some(6),
        ..DiffRequest::default()
    }
}

#[tokio::test]
async fn full_sha_commit_data_is_served_from_cache_without_git() {
    let dir = repo_dir().await;
    write(dir.path(), "a.txt", "one\n");
    git(dir.path(), &["add", "."]).await;
    git(dir.path(), &["commit", "-m", "first"]).await;
    write(dir.path(), "a.txt", "two\n");
    git(dir.path(), &["commit", "-am", "second"]).await;
    let sha = git(dir.path(), &["rev-parse", "HEAD"]).await;
    let repo = GitRepositoryService::open(dir.path()).await.unwrap();
    let request = commit_request(&sha, "a.txt");

    let details = repo.commit_details(&sha, None).await.unwrap();
    let files = repo.commit_files(&sha, None).await.unwrap();
    let diff = repo.diff(&request).await.unwrap();
    assert!(diff.contains("+two"));

    hide_git_dir(dir.path());
    assert_eq!(repo.commit_details(&sha, None).await.unwrap(), details);
    assert_eq!(repo.commit_files(&sha, None).await.unwrap(), files);
    assert_eq!(repo.diff(&request).await.unwrap(), diff);
    // A different context size is a different diff.
    let mut other = request.clone();
    other.context = Some(1);
    assert!(repo.diff(&other).await.is_err());
}

#[tokio::test]
async fn ref_names_and_working_tree_diffs_are_never_cached() {
    let dir = repo_dir().await;
    write(dir.path(), "a.txt", "one\n");
    git(dir.path(), &["add", "."]).await;
    git(dir.path(), &["commit", "-m", "first"]).await;
    let repo = GitRepositoryService::open(dir.path()).await.unwrap();

    repo.commit_files("HEAD", None).await.unwrap();
    repo.commit_details("main", None).await.unwrap();
    write(dir.path(), "a.txt", "changed\n");
    let unstaged = DiffRequest {
        path: Some("a.txt".into()),
        ..DiffRequest::default()
    };
    assert!(repo.diff(&unstaged).await.unwrap().contains("+changed"));
    git(dir.path(), &["add", "a.txt"]).await;
    let staged = DiffRequest {
        staged: true,
        ..unstaged.clone()
    };
    assert!(repo.diff(&staged).await.unwrap().contains("+changed"));
    write(dir.path(), "a.txt", "changed again\n");
    assert!(
        repo.diff(&unstaged)
            .await
            .unwrap()
            .contains("+changed again")
    );

    let caches = repo.caches();
    assert!(caches.details.is_empty());
    assert!(caches.files.is_empty());
    assert!(caches.diffs.is_empty());
}

#[tokio::test]
async fn amending_a_commit_misses_the_cache_for_the_new_sha() {
    let dir = repo_dir().await;
    write(dir.path(), "a.txt", "one\n");
    git(dir.path(), &["add", "."]).await;
    git(dir.path(), &["commit", "-m", "first"]).await;
    let old = git(dir.path(), &["rev-parse", "HEAD"]).await;
    let repo = GitRepositoryService::open(dir.path()).await.unwrap();
    let request = commit_request(&old, "a.txt");
    assert!(repo.diff(&request).await.unwrap().contains("+one"));

    write(dir.path(), "a.txt", "amended\n");
    git(dir.path(), &["commit", "-a", "--amend", "-m", "first"]).await;
    let new = git(dir.path(), &["rev-parse", "HEAD"]).await;
    assert_ne!(old, new);
    let diff = repo.diff(&commit_request(&new, "a.txt")).await.unwrap();
    assert!(diff.contains("+amended") && !diff.contains("+one\n"));
    assert!(repo.diff(&request).await.unwrap().contains("+one"));
}

#[tokio::test]
async fn stash_commits_are_not_cached() {
    let dir = repo_dir().await;
    write(dir.path(), "a.txt", "one\n");
    git(dir.path(), &["add", "."]).await;
    git(dir.path(), &["commit", "-m", "first"]).await;
    write(dir.path(), "a.txt", "tracked change\n");
    write(dir.path(), "new.txt", "untracked\n");
    git(dir.path(), &["stash", "push", "-u"]).await;
    let stash = git(dir.path(), &["rev-parse", "refs/stash"]).await;
    let repo = GitRepositoryService::open(dir.path()).await.unwrap();

    let files = repo.commit_files(&stash, None).await.unwrap();
    assert!(files.iter().any(|f| f.path == "new.txt"));
    let diff = repo.diff(&commit_request(&stash, "new.txt")).await.unwrap();
    assert!(diff.contains("+untracked"));
    {
        let caches = repo.caches();
        assert!(caches.details.is_empty());
        assert!(caches.files.is_empty());
        assert!(caches.diffs.is_empty());
    }

    // Once the stash is dropped, Git no longer treats the commit as a stash.
    git(dir.path(), &["stash", "drop"]).await;
    let files = repo.commit_files(&stash, None).await.unwrap();
    assert!(files.iter().all(|f| f.path != "new.txt"));
}
