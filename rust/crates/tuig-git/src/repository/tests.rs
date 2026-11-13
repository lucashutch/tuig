use std::path::Path;

use super::*;
use crate::process::{GitCommandAbortedError, GitOutputLimitError, run_git};
use crate::test_util::{TempDir, temp_repo};
use crate::types::SubmoduleState;

fn git(dir: &Path, args: &[&str]) -> String {
    run_git(args, Some(dir))
        .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
        .stdout
        .trim()
        .to_string()
}

fn git_env(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> String {
    let mut options = RunOptions::in_dir(dir);
    options.env = env
        .iter()
        .map(|(k, v)| (k.to_string(), Some(v.to_string())))
        .collect();
    run_git_with(args, &options)
        .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
        .stdout
        .trim()
        .to_string()
}

/// A repository on `main` with a committer identity.
fn repo_dir() -> TempDir {
    let dir = temp_repo();
    git(dir.path(), &["config", "user.name", "Test User"]);
    git(dir.path(), &["config", "user.email", "test@example.com"]);
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

fn open(dir: &TempDir) -> GitRepositoryService {
    GitRepositoryService::open(dir.path()).unwrap()
}

/// Write, stage, and commit one file through the service.
fn commit_file(repo: &GitRepositoryService, dir: &Path, name: &str, body: &str, message: &str) {
    write(dir, name, body);
    repo.stage(&paths(&[name])).unwrap();
    repo.commit(message).unwrap();
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

#[test]
fn working_status_lists_files_inside_untracked_directories() {
    let dir = temp_repo();
    write(dir.path(), ".claude/notes/a.md", "hello\n");
    write(dir.path(), ".claude/empty.txt", "");
    let repo = open(&dir);

    let mut listed: Vec<String> = repo
        .working_status()
        .unwrap()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect();
    listed.sort();

    assert_eq!(listed, [".claude/empty.txt", ".claude/notes/a.md"]);
}

#[test]
fn linked_worktrees_are_hidden_from_changes_and_know_their_main_checkout() {
    let dir = repo_dir();
    git(dir.path(), &["commit", "--allow-empty", "-m", "init"]);
    git(
        dir.path(),
        &[
            "worktree",
            "add",
            "-b",
            "feature",
            ".claude/worktrees/feature",
        ],
    );
    git(dir.path(), &["init", "-b", "main", "vendor/other"]);
    let repo = open(&dir);

    let working: Vec<String> = repo
        .working_status()
        .unwrap()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect();
    let snapshot: Vec<String> = repo
        .snapshot(DEFAULT_HISTORY_PAGE)
        .unwrap()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect();

    assert_eq!(working, ["vendor/other/"]);
    assert_eq!(snapshot, ["vendor/other/"]);
    assert_eq!(repo.main_worktree(), None);
    let linked = GitRepositoryService::open(dir.path().join(".claude/worktrees/feature")).unwrap();
    assert_eq!(linked.main_worktree(), Some(repo.root()));
}

#[test]
fn discard_removes_selected_untracked_content_and_keeps_staged_content() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "tracked.txt"]);
    git(root, &["commit", "-m", "initial"]);
    write(root, "tracked.txt", "staged\n");
    git(root, &["add", "tracked.txt"]);
    write(root, "tracked.txt", "unstaged\n");
    write(root, "new-dir/new.txt", "new\n");
    write(root, ".gitignore", "ignored.txt\nnew-dir/ignored/\n");
    write(root, "ignored.txt", "keep\n");
    write(root, "new-dir/ignored/keep.txt", "keep\n");

    open(&dir)
        .discard(&paths(&["tracked.txt", "new-dir"]))
        .unwrap();

    assert_eq!(read(root, "tracked.txt"), "staged\n");
    assert!(!root.join("new-dir/new.txt").exists());
    assert!(root.join("new-dir/ignored/keep.txt").exists());
    assert!(root.join("ignored.txt").exists());
    assert!(git(root, &["diff", "--cached", "--", "tracked.txt"]).contains("staged"));
}

#[test]
fn discard_treats_wildcard_paths_literally() {
    let dir = repo_dir();
    let root = dir.path();
    for name in ["tracked*.txt", "tracked-neighbor.txt"] {
        write(root, name, "base\n");
    }
    git(root, &["add", "--all"]);
    git(root, &["commit", "-m", "initial"]);
    write(root, "tracked*.txt", "discard\n");
    write(root, "tracked-neighbor.txt", "keep\n");
    write(root, "untracked?.txt", "discard\n");
    write(root, "untracked1.txt", "keep\n");
    write(root, "bracket[1].txt", "discard\n");
    write(root, "bracket1.txt", "keep\n");
    write(root, ":(glob)magic", "discard\n");
    write(root, "magic", "keep\n");

    open(&dir)
        .discard(&paths(&[
            "tracked*.txt",
            "untracked?.txt",
            "bracket[1].txt",
            ":(glob)magic",
        ]))
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

#[test]
fn remote_deletion_removes_the_server_branch_but_keeps_the_local_copy() {
    let dir = repo_dir();
    let remote = TempDir::new("tuig-delete-remote");
    git(remote.path(), &["init", "--bare"]);
    git(dir.path(), &["commit", "--allow-empty", "-m", "initial"]);
    git(
        dir.path(),
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(dir.path(), &["branch", "feature/topic"]);
    git(dir.path(), &["push", "-u", "origin", "feature/topic"]);

    open(&dir)
        .delete_remote_branch("origin/feature/topic", None)
        .unwrap();

    assert_eq!(
        git(
            remote.path(),
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/heads/feature/topic"
            ]
        ),
        ""
    );
    git(
        dir.path(),
        &["show-ref", "--verify", "refs/heads/feature/topic"],
    );
}

#[test]
fn deleting_a_branch_without_a_matching_remote_fails() {
    let dir = repo_dir();
    git(dir.path(), &["commit", "--allow-empty", "-m", "initial"]);
    let message = error_text(open(&dir).delete_remote_branch("origin/topic", None));
    assert_eq!(message, "No configured remote for origin/topic");
}

#[test]
fn opening_a_non_repository_reports_a_launch_error() {
    let dir = TempDir::new("tuig-not-repo");
    let shown = dir.path().display().to_string();
    let error = GitRepositoryService::open(dir.path()).err().unwrap();
    assert!(matches!(error, GitError::NotRepository(_)));
    assert_eq!(
        error.to_string(),
        format!(
            "No Git repository found at \"{shown}\".\n\nHint: Run tuig from inside a Git repository or pass the path to one."
        )
    );
}

#[test]
fn opening_a_folder_suggests_up_to_three_repositories_inside_it() {
    let dir = TempDir::new("tuig-parent");
    for name in ["delta", "alpha", "charlie", "bravo"] {
        git(
            dir.path(),
            &["init", dir.path().join(name).to_str().unwrap()],
        );
    }
    let root = dir.path();
    let message = error_text(GitRepositoryService::open(root));
    assert!(message.contains(&format!(
        "Repositories found nearby:\n  tuig {}\n  tuig {}\n  tuig {}",
        root.join("alpha").display(),
        root.join("bravo").display(),
        root.join("charlie").display()
    )));
}

#[test]
fn a_misspelled_path_suggests_a_similarly_named_sibling() {
    let dir = TempDir::new("tuig-siblings");
    let root = dir.path();
    git(root, &["init", root.join("project").to_str().unwrap()]);
    let message = error_text(GitRepositoryService::open(root.join("porject")));
    assert!(message.contains(&format!(
        "Path \"{}\" does not exist.\n\nRepositories found nearby:\n  tuig {}",
        root.join("porject").display(),
        root.join("project").display()
    )));
}

#[test]
fn repository_suggestions_are_validated_and_shell_quoted() {
    let dir = TempDir::new("tuig-suggestions");
    let root = dir.path();
    git(root, &["init", root.join("valid repo").to_str().unwrap()]);
    write(root, "not-a-repo/.git", "not git metadata");
    let message = error_text(GitRepositoryService::open(root));
    assert!(message.contains(&format!(
        "Repositories found nearby:\n  tuig '{}'",
        root.join("valid repo").display()
    )));
    assert!(!message.contains("not-a-repo"));
}

#[test]
fn opening_a_file_reports_that_it_is_not_a_directory() {
    let dir = TempDir::new("tuig-file");
    write(dir.path(), "README.md", "content");
    let file = dir.path().join("README.md");
    assert!(
        error_text(GitRepositoryService::open(&file))
            .starts_with(&format!("Path \"{}\" is not a directory.", file.display()))
    );
}

#[test]
fn stages_commits_and_reports_an_odd_filename() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "odd name.txt", "one\n");
    let repo = open(&dir);
    let request = |path: &str| DiffRequest {
        path: Some(path.into()),
        ..DiffRequest::default()
    };
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().files[0].path,
        "odd name.txt"
    );
    assert!(
        repo.diff(&request("odd name.txt"))
            .unwrap()
            .contains("+one")
    );
    repo.stage(&paths(&["odd name.txt"])).unwrap();
    repo.commit("initial").unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().commits[0].subject,
        "initial"
    );
    let files = repo.commit_files("HEAD", None).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(
        (files[0].path.as_str(), files[0].state),
        ("odd name.txt", FileState::Added)
    );

    write(root, "odd name.txt", "one\ntwo\n");
    assert!(
        repo.diff(&request("odd name.txt"))
            .unwrap()
            .contains("+two")
    );
    repo.stage(&paths(&["odd name.txt"])).unwrap();
    repo.commit("second").unwrap();
    let commits = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().commits;
    assert_eq!(commits.len(), 2);
    assert!(
        commits
            .iter()
            .all(|c| c.sha.len() == 40 && c.sha.bytes().all(|b| b.is_ascii_hexdigit()))
    );
    let first = repo.commit_files(&commits[1].sha, None).unwrap();
    assert_eq!(first[0].state, FileState::Added);
    let between = repo
        .commit_files(&commits[0].sha, Some(&commits[1].sha))
        .unwrap();
    assert_eq!(between.len(), 1);
    assert_eq!(between[0].state, FileState::Modified);
    let comparison = DiffRequest {
        base: Some(commits[1].sha.clone()),
        target: Some(commits[0].sha.clone()),
        ..DiffRequest::default()
    };
    assert!(repo.diff(&comparison).unwrap().contains("+two"));

    write(root, "odd name.txt", "stashed\n");
    repo.stash(Some("visible stash"), false).unwrap();
    let stash = &repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().stashes[0];
    assert_eq!(stash.reference, "stash@{0}");
    assert!(stash.subject.contains("visible stash"));
}

#[test]
fn file_history_follows_a_renamed_option_like_path_from_an_optional_ref() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "old name.txt", "one\n");
    git(root, &["add", "--", "old name.txt"]);
    git(root, &["commit", "-m", "add file"]);
    let added = git(root, &["rev-parse", "HEAD"]);
    git(root, &["mv", "--", "old name.txt", "--new name.txt"]);
    git(root, &["commit", "-m", "rename file"]);
    let renamed = git(root, &["rev-parse", "HEAD"]);
    write(root, "--new name.txt", "one\ntwo\n");
    git(root, &["add", "--", "--new name.txt"]);
    git(root, &["commit", "-m", "edit renamed file"]);

    let repo = open(&dir);
    let history = repo.file_history("--new name.txt", None).unwrap();
    assert_eq!(
        subjects(&history),
        ["edit renamed file", "rename file", "add file"]
    );
    assert_eq!(history[2].sha, added);
    assert_eq!(history[2].author, "Test User");
    assert_eq!(history[2].committer, "Test User");
    let from_ref = repo.file_history("--new name.txt", Some(&renamed)).unwrap();
    assert_eq!(subjects(&from_ref), ["rename file", "add file"]);
    assert_eq!(
        error_text(repo.file_history("--new name.txt", Some("--all"))),
        "A commit is required"
    );
}

#[test]
fn line_blame_reports_commit_and_original_location_across_edits_and_a_rename() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "before name.txt", "alpha\nbeta\n");
    git(root, &["add", "--", "before name.txt"]);
    git(root, &["commit", "-m", "write beta"]);
    let source = git(root, &["rev-parse", "HEAD"]);
    git(root, &["mv", "--", "before name.txt", "--after name.txt"]);
    write(root, "--after name.txt", "intro\nalpha\nbeta\n");
    git(root, &["add", "--", "--after name.txt"]);
    git(root, &["commit", "-m", "move lines"]);
    let moved = git(root, &["rev-parse", "HEAD"]);

    let repo = open(&dir);
    let blame = repo.blame_line("--after name.txt", 3, None).unwrap();
    assert_eq!(blame.commit.sha, source);
    assert_eq!(blame.commit.subject, "write beta");
    assert_eq!(blame.commit.author, "Test User");
    assert_eq!(blame.original_path, "before name.txt");
    assert_eq!((blame.original_line, blame.final_line), (2, 3));
    assert_eq!(blame.final_path, "--after name.txt");

    let at_moved = repo
        .blame_line("--after name.txt", 1, Some(&moved))
        .unwrap();
    assert_eq!(at_moved.commit.sha, moved);
    assert_eq!(at_moved.commit.subject, "move lines");
    assert_eq!((at_moved.original_line, at_moved.final_line), (1, 1));

    let lines = repo.line_history("--after name.txt", 3, None).unwrap();
    assert_eq!(subjects(&lines), ["write beta"]);
    let zero = repo.blame_line("--after name.txt", 0, None).err().unwrap();
    assert_eq!(
        zero.to_string(),
        "A positive 1-based line number is required"
    );
    assert_eq!(
        error_text(repo.blame_line("--after name.txt", 1, Some("--contents=/etc/passwd"))),
        "A commit is required"
    );
}

#[test]
fn quoted_blame_paths_decode_escapes_and_octal_bytes() {
    assert_eq!(parse_git_quoted_path("plain"), "plain");
    assert_eq!(parse_git_quoted_path(r#""a\tb\"c\\d""#), "a\tb\"c\\d");
    assert_eq!(parse_git_quoted_path(r#""caf\303\251""#), "café");
    assert_eq!(parse_git_quoted_path(r#""\q""#), "q");
}

#[test]
fn snapshot_keeps_stash_internal_commits_out_of_history() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "file", "base\n");
    git(root, &["add", "file"]);
    git(root, &["commit", "-m", "base"]);
    let repo = open(&dir);

    write(root, "file", "staged change\n");
    repo.stage(&paths(&["file"])).unwrap();
    write(root, "file", "worktree change\n");
    write(root, "untracked.txt", "untracked\n");
    repo.stash(Some("history stash"), true).unwrap();

    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
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

#[test]
fn stash_tip_pages_with_history_instead_of_shifting_it() {
    let dir = repo_dir();
    let repo = open(&dir);
    for name in ["one", "two", "three"] {
        commit_file(
            &repo,
            dir.path(),
            &format!("{name}.txt"),
            &format!("{name}\n"),
            name,
        );
    }
    write(dir.path(), "three.txt", "stashed\n");
    repo.stash(Some("paged stash"), false).unwrap();

    let first = repo.commit_page(2, 0).unwrap();
    assert!(first.commits[0].subject.contains("paged stash"));
    assert_eq!(first.commits[1].subject, "three");
    assert_eq!(first.commits.len(), 2);
    assert!(!first.complete);
    let second = repo.commit_page(3, 1).unwrap();
    assert_eq!(subjects(&second.commits), ["three", "two", "one"]);
    assert!(second.complete);
}

#[test]
fn shows_a_stash_at_its_creation_time_in_history() {
    let dir = repo_dir();
    let root = dir.path();
    let at = |date: &'static str| [("GIT_AUTHOR_DATE", date), ("GIT_COMMITTER_DATE", date)];
    write(root, "file", "base\n");
    git(root, &["add", "file"]);
    git_env(root, &["commit", "-m", "base"], &at("2026-01-01T00:00:00Z"));
    write(root, "file", "stashed\n");
    git_env(
        root,
        &["stash", "push", "-m", "middle stash"],
        &at("2026-01-02T00:00:00Z"),
    );
    write(root, "newer", "newer\n");
    git(root, &["add", "newer"]);
    git_env(
        root,
        &["commit", "-m", "newer"],
        &at("2026-01-03T00:00:00Z"),
    );

    let commits = open(&dir).snapshot(DEFAULT_HISTORY_PAGE).unwrap().commits;
    assert_eq!(commits.len(), 3);
    assert_eq!(commits[0].subject, "newer");
    assert!(commits[1].subject.contains("middle stash"));
    assert_eq!(commits[2].subject, "base");
}

#[test]
fn diff_enforces_byte_limits_and_preserves_cancellation_errors() {
    let dir = temp_repo();
    write(dir.path(), "large.txt", &"x".repeat(100_000));
    let repo = open(&dir);
    let limited = repo
        .diff(&DiffRequest {
            path: Some("large.txt".into()),
            max_bytes: Some(100),
            ..DiffRequest::default()
        })
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
        .err()
        .unwrap();
    assert!(matches!(
        cancelled,
        GitError::Aborted(GitCommandAbortedError { .. })
    ));
}

#[test]
fn diff_of_an_untracked_file_uses_no_index_and_tracked_clean_file_is_empty() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "tracked.txt", "one\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "base"]);
    write(root, "new.txt", "fresh\n");
    let repo = open(&dir);
    let request = |path: &str| DiffRequest {
        path: Some(path.into()),
        ..DiffRequest::default()
    };
    let patch = repo.diff(&request("new.txt")).unwrap();
    assert!(patch.contains("new file mode"));
    assert!(patch.contains("+fresh"));
    assert_eq!(repo.diff(&request("tracked.txt")).unwrap(), "");
}

#[test]
fn refresh_reuses_history_for_worktree_edits_and_reloads_moved_refs() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "file", "one\n");
    git(root, &["add", "file"]);
    git(root, &["commit", "-m", "one"]);
    let repo = open(&dir);
    let first = repo.snapshot(1).unwrap();
    let starts = repo.walk_starts();

    write(root, "file", "two\n");
    let worktree_refresh = repo.refresh_snapshot(&first, 1).unwrap();
    assert_eq!(worktree_refresh.commits, first.commits);
    assert_eq!(worktree_refresh.files.len(), 1);
    assert_eq!(repo.walk_starts(), starts, "worktree edits reuse history");

    git(root, &["tag", "new-tag"]);
    let ref_refresh = repo.refresh_snapshot(&worktree_refresh, 1).unwrap();
    assert_eq!(repo.walk_starts(), starts + 1, "a new tag reloads history");
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

#[test]
fn refresh_extends_an_unchanged_incomplete_history_page() {
    let dir = repo_dir();
    for name in ["one", "two", "three"] {
        write(dir.path(), name, name);
        git(dir.path(), &["add", name]);
        git(dir.path(), &["commit", "-m", name]);
    }
    let repo = open(&dir);
    let first = repo.snapshot(1).unwrap();
    assert!(!first.commits_complete);
    let extended = repo.refresh_snapshot(&first, 3).unwrap();
    assert_eq!(extended.commits.len(), 3);
    let starts = repo.walk_starts();
    let reused = repo.refresh_snapshot(&extended, 2).unwrap();
    assert_eq!(reused.commits, extended.commits);
    assert_eq!(repo.walk_starts(), starts);
}

#[test]
fn a_snapshot_the_service_did_not_build_always_reloads() {
    let dir = repo_dir();
    git(dir.path(), &["commit", "--allow-empty", "-m", "one"]);
    let repo = open(&dir);
    let starts = repo.walk_starts();
    let foreign = RepositorySnapshot {
        commits_complete: true,
        ..RepositorySnapshot::default()
    };
    let refreshed = repo.refresh_snapshot(&foreign, 10).unwrap();
    assert_eq!(refreshed.commits.len(), 1);
    assert_eq!(repo.walk_starts(), starts + 1);
}

#[test]
fn poll_notices_unborn_branch_creation_and_detached_head_movement() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    let empty = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(empty.branch.as_deref(), Some("main"));
    assert!(empty.commits.is_empty());

    git(root, &["commit", "--allow-empty", "-m", "one"]);
    let first = repo.refresh_snapshot(&empty, DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(first.commits.len(), 1);
    git(root, &["commit", "--allow-empty", "-m", "two"]);
    let second = repo.refresh_snapshot(&first, DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(second.commits.len(), 2);

    git(root, &["checkout", "--detach", "HEAD~1"]);
    let before = repo.walk_starts();
    let detached = repo
        .refresh_snapshot(&second, DEFAULT_HISTORY_PAGE)
        .unwrap();
    assert_eq!(detached.branch, None);
    assert_eq!(repo.walk_starts(), before + 1);
    let head = detached
        .commits
        .iter()
        .find(|c| c.decorations.iter().any(|d| d == "HEAD"))
        .unwrap();
    assert_eq!(head.sha, first.commits[0].sha);

    let before = repo.walk_starts();
    repo.refresh_snapshot(&detached, DEFAULT_HISTORY_PAGE)
        .unwrap();
    assert_eq!(repo.walk_starts(), before);
}

#[test]
fn deepening_while_still_shallow_invalidates_history_without_moved_refs() {
    let source = repo_dir();
    for i in 0..4 {
        git(
            source.path(),
            &["commit", "--allow-empty", "-m", &format!("commit {i}")],
        );
    }
    let dir = TempDir::new("tuig-shallow");
    let url = format!("file://{}", source.path().display());
    git(
        dir.path(),
        &["clone", "--depth=1", &url, dir.path().to_str().unwrap()],
    );
    let repo = open(&dir);
    let first = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(first.commits.len(), 1);

    git(dir.path(), &["fetch", "--deepen=1"]);
    assert_eq!(
        git(dir.path(), &["rev-parse", "--is-shallow-repository"]),
        "true"
    );
    let deeper = repo.refresh_snapshot(&first, DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(deeper.branches, first.branches);
    assert_eq!(deeper.commits.len(), 2);
}

#[test]
fn linked_worktrees_use_the_shared_graft_metadata_path() {
    let source = repo_dir();
    for i in 0..3 {
        git(
            source.path(),
            &["commit", "--allow-empty", "-m", &format!("commit {i}")],
        );
    }
    let dir = TempDir::new("tuig-graft");
    git(
        source.path(),
        &[
            "worktree",
            "add",
            "--detach",
            dir.path().to_str().unwrap(),
            "HEAD",
        ],
    );
    let repo = open(&dir);
    let first = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(first.commits.len(), 3);
    let graft_path = git(
        dir.path(),
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/grafts",
        ],
    );
    std::fs::write(&graft_path, format!("{}\n", first.commits[0].sha)).unwrap();

    let grafted = repo.refresh_snapshot(&first, DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(grafted.commits.len(), 1);
    std::fs::remove_file(&graft_path).unwrap();
    let restored = repo
        .refresh_snapshot(&grafted, DEFAULT_HISTORY_PAGE)
        .unwrap();
    assert_eq!(restored.commits.len(), 3);
}

#[test]
fn paging_into_the_same_snapshot_retains_cheap_refresh_eligibility() {
    let dir = repo_dir();
    for i in 0..4 {
        git(
            dir.path(),
            &["commit", "--allow-empty", "-m", &format!("commit {i}")],
        );
    }
    let repo = open(&dir);
    let mut first = repo.snapshot(1).unwrap();
    let page = repo.commit_page(2, 1).unwrap();
    first.commits.extend(page.commits);
    first.commits_complete = page.complete;
    let starts = repo.walk_starts();

    let refreshed = repo.refresh_snapshot(&first, 3).unwrap();
    assert_eq!(refreshed.commits, first.commits);
    assert_eq!(refreshed.commits.len(), 3);
    assert_eq!(repo.walk_starts(), starts);
}

#[test]
fn snapshot_enriches_recursively_reported_submodules_with_gitmodules_names() {
    let source = repo_dir();
    write(source.path(), "readme", "source\n");
    git(source.path(), &["add", "readme"]);
    git(source.path(), &["commit", "-m", "source"]);
    let dir = repo_dir();
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
    );
    write(
        root,
        ".gitmodules",
        &format!(
            "[submodule \"library repository\"]\n\tpath = modules/nested path\n\turl = {}\n",
            source.path().display()
        ),
    );

    let repo = open(&dir);
    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(snapshot.submodules.len(), 1);
    assert_eq!(snapshot.submodules[0].path, "modules/nested path");
    assert_eq!(
        snapshot.submodules[0].name.as_deref(),
        Some("library repository")
    );
    assert_ne!(snapshot.submodules[0].state, SubmoduleState::Conflicted);
    repo.sync_submodule("modules/nested path").unwrap();
    repo.update_submodule("modules/nested path", true).unwrap();
    assert_eq!(read(root, "modules/nested path/readme"), "source\n");
    assert_eq!(
        error_text(repo.update_submodule("  ", false)),
        "A submodule path is required"
    );
}

#[test]
fn fetch_prunes_remote_tracking_branches_deleted_on_the_remote() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "file", "initial\n");
    git(root, &["add", "file"]);
    git(root, &["commit", "-m", "initial"]);
    let remote = TempDir::new("tuig-fetch-remote");
    git(
        root,
        &[
            "clone",
            "--bare",
            root.to_str().unwrap(),
            remote.path().to_str().unwrap(),
        ],
    );
    git(
        root,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(root, &["switch", "-c", "topic"]);
    git(root, &["push", "-u", "origin", "topic"]);
    let repo = open(&dir);
    let has_topic = |repo: &GitRepositoryService| {
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .unwrap()
            .branches
            .iter()
            .any(|r| r.name == "origin/topic")
    };
    assert!(has_topic(&repo));
    git(root, &["push", "origin", "--delete", "topic"]);
    repo.fetch(None, None).unwrap();
    assert!(!has_topic(&repo));
    assert!(!repo.auth_blocked());
}

#[test]
fn snapshot_tolerates_a_malformed_gitmodules_file() {
    let dir = temp_repo();
    write(dir.path(), ".gitmodules", "[submodule broken\n");
    let snapshot = open(&dir).snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    assert!(snapshot.submodules.is_empty());
}

#[test]
fn amends_head_using_only_staged_changes() {
    let dir = repo_dir();
    let repo = open(&dir);
    commit_file(&repo, dir.path(), "staged.txt", "one\n", "initial");
    write(dir.path(), "staged.txt", "two\n");
    repo.stage(&paths(&["staged.txt"])).unwrap();
    write(dir.path(), "unstaged.txt", "leave me\n");
    repo.amend_commit("amended\n\nfull message").unwrap();

    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    assert_eq!(snapshot.commits[0].subject, "amended");
    assert_eq!(snapshot.commits[0].body.as_deref(), Some("full message"));
    assert_eq!(read(dir.path(), "unstaged.txt"), "leave me\n");
    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].path, "unstaged.txt");
    assert!(snapshot.files[0].unstaged);
}

#[test]
fn rewords_a_non_head_commit_and_refuses_a_dirty_worktree() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    commit_file(&repo, root, "a", "a\n", "first");
    commit_file(&repo, root, "b", "b\n", "second");
    let first = repo
        .snapshot(DEFAULT_HISTORY_PAGE)
        .unwrap()
        .commits
        .into_iter()
        .find(|c| c.subject == "first")
        .unwrap();
    write(root, "dirty", "x");
    assert!(error_text(repo.reword_commit(&first.sha, "renamed")).contains("dirty worktree"));
    git(root, &["clean", "-fd"]);

    repo.reword_commit(&first.sha, "renamed\n\nnew body")
        .unwrap();

    let commits = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().commits;
    assert_eq!(subjects(&commits), ["second", "renamed"]);
    assert_eq!(commits[1].body.as_deref(), Some("new body"));
    assert_eq!(commits[1].author, "Test User");
    assert_eq!(read(root, "a"), "a\n");
    assert_eq!(read(root, "b"), "b\n");
}

#[test]
fn rewords_root_and_head_commits_without_changing_their_trees() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    commit_file(&repo, root, "root.txt", "root\n", "root");
    let root_sha = git(root, &["rev-parse", "HEAD"]);
    let root_tree = git(root, &["show", "-s", "--format=%T", &root_sha]);
    repo.reword_commit(&root_sha, "renamed root").unwrap();
    assert_eq!(git(root, &["log", "-1", "--format=%s"]), "renamed root");
    assert_eq!(git(root, &["show", "-s", "--format=%T", "HEAD"]), root_tree);

    commit_file(&repo, root, "head.txt", "head\n", "head");
    let head_sha = git(root, &["rev-parse", "HEAD"]);
    let head_tree = git(root, &["show", "-s", "--format=%T", "HEAD"]);
    repo.reword_commit(&head_sha, "renamed head").unwrap();
    assert_eq!(git(root, &["log", "-1", "--format=%s"]), "renamed head");
    assert_eq!(git(root, &["show", "-s", "--format=%T", "HEAD"]), head_tree);
}

#[test]
fn rewords_merge_commits_while_preserving_merge_topology_and_tree() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    commit_file(&repo, root, "base", "base\n", "base");
    repo.create_branch("topic", None, false).unwrap();
    repo.switch_branch("topic").unwrap();
    commit_file(&repo, root, "topic", "topic\n", "topic");
    repo.switch_branch("main").unwrap();
    commit_file(&repo, root, "main", "main\n", "main");
    git(root, &["merge", "--no-ff", "topic", "-m", "merge topic"]);
    let merge = git(root, &["rev-parse", "HEAD"]);
    let tree = git(root, &["show", "-s", "--format=%T", "HEAD"]);

    let files = repo.commit_files(&merge, None).unwrap();
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
        .unwrap();
    assert!(patch.contains("diff --git a/topic b/topic"));
    assert!(!patch.contains("diff --git a/main b/main"));

    repo.reword_commit(&merge, "renamed merge").unwrap();
    assert_eq!(git(root, &["log", "-1", "--format=%s"]), "renamed merge");
    assert_eq!(
        git(root, &["show", "-s", "--format=%P", "HEAD"])
            .split(' ')
            .count(),
        2
    );
    assert_eq!(git(root, &["show", "-s", "--format=%T", "HEAD"]), tree);
}

#[test]
fn reword_refuses_a_detached_head() {
    let dir = repo_dir();
    let repo = open(&dir);
    commit_file(&repo, dir.path(), "a", "a\n", "first");
    git(dir.path(), &["checkout", "--detach"]);
    assert_eq!(
        error_text(repo.reword_commit("HEAD", "x")),
        "Cannot reword a commit while HEAD is detached"
    );
}

#[test]
fn aborts_a_failed_reword_rebase_before_cleaning_up_helpers() {
    use std::os::unix::fs::PermissionsExt;
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    commit_file(&repo, root, "a", "a\n", "first");
    let sha = git(root, &["rev-parse", "HEAD"]);
    let hook = root.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(repo.reword_commit(&sha, "will fail").is_err());

    assert!(run_git(&["rev-parse", "--verify", "REBASE_HEAD"], Some(root)).is_err());
    assert_eq!(git(root, &["status", "--porcelain"]), "");
}

#[test]
fn checks_out_commits_and_branches_resets_and_rebases() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    commit_file(&repo, root, "a.txt", "one\n", "first");
    let first = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().commits[0]
        .sha
        .clone();
    commit_file(&repo, root, "b.txt", "two\n", "second");

    repo.checkout_commit(&first).unwrap();
    assert_eq!(repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().branch, None);
    repo.switch_branch("main").unwrap();

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
    );
    git(
        root,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    git(root, &["fetch", "origin"]);
    repo.checkout_remote_branch("copy", "origin/main", false)
        .unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .unwrap()
            .branch
            .as_deref(),
        Some("copy")
    );

    let head_subject = || git(root, &["log", "-1", "--format=%s"]);
    repo.reset_to(&first, ResetMode::Hard).unwrap();
    assert_eq!(head_subject(), "first");
    // `copy` now trails the remote, so the reset checkout must move it forward.
    repo.switch_branch("main").unwrap();
    repo.checkout_remote_branch("copy", "origin/main", true)
        .unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .unwrap()
            .branch
            .as_deref(),
        Some("copy")
    );
    assert_eq!(head_subject(), "second");

    repo.reset_to(&first, ResetMode::Hard).unwrap();
    repo.rebase_onto("main").unwrap();
    assert_eq!(head_subject(), "second");
}

#[test]
fn creates_branches_and_tags_cherry_picks_and_manages_stashes() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    commit_file(&repo, root, "file", "base\n", "base");
    repo.create_branch("topic", None, true).unwrap();
    commit_file(&repo, root, "topic", "topic\n", "topic change");
    let topic_commit = git(root, &["rev-parse", "HEAD"]);
    repo.switch_branch("main").unwrap();
    repo.cherry_pick(&topic_commit).unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .unwrap()
            .branch
            .as_deref(),
        Some("main")
    );
    assert_eq!(read(root, "topic"), "topic\n");

    repo.create_tag("v1", Some(&topic_commit)).unwrap();
    assert_eq!(git(root, &["cat-file", "-t", "refs/tags/v1"]), "commit");
    assert_eq!(git(root, &["rev-parse", "v1"]), topic_commit);
    repo.create_tag("head-tag", None).unwrap();
    assert_eq!(
        git(root, &["rev-parse", "head-tag"]),
        git(root, &["rev-parse", "HEAD"])
    );
    let remote = TempDir::new("tuig-tag-remote");
    git(remote.path(), &["init", "--bare"]);
    git(
        root,
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
    );
    repo.push_tag("v1", Some("origin"), None).unwrap();
    assert_eq!(
        git(remote.path(), &["rev-parse", "refs/tags/v1"]),
        topic_commit
    );
    repo.delete_tag("head-tag").unwrap();
    assert!(run_git(&["show-ref", "--verify", "refs/tags/head-tag"], Some(root)).is_err());

    write(root, "file", "stashed\n");
    repo.stash(Some("keep this"), false).unwrap();
    let stash_ref = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().stashes[0]
        .reference
        .clone();
    repo.apply_stash(&stash_ref, false).unwrap();
    assert_eq!(read(root, "file"), "stashed\n");
    repo.discard_all().unwrap();
    repo.pop_stash(&stash_ref).unwrap();
    assert_eq!(read(root, "file"), "stashed\n");
    assert!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .unwrap()
            .stashes
            .is_empty()
    );

    write(root, "file", "drop me\n");
    repo.stash(Some("drop this"), false).unwrap();
    let drop_ref = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().stashes[0]
        .reference
        .clone();
    repo.rename_stash(&drop_ref, "renamed stash").unwrap();
    let stashes = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().stashes;
    assert!(stashes[0].subject.contains("renamed stash"));
    repo.drop_stash(&stashes[0].reference).unwrap();
    assert!(
        repo.snapshot(DEFAULT_HISTORY_PAGE)
            .unwrap()
            .stashes
            .is_empty()
    );
    // No backup refs remain after a successful rename.
    assert_eq!(git(root, &["for-each-ref", "refs/tuig"]), "");
}

#[test]
fn renaming_a_stash_keeps_the_other_stashes_in_order() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    commit_file(&repo, root, "file", "base\n", "base");
    for name in ["one", "two", "three"] {
        write(root, "file", &format!("{name}\n"));
        repo.stash(Some(name), false).unwrap();
    }
    repo.rename_stash("stash@{1}", "renamed").unwrap();
    let stashes = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().stashes;
    assert_eq!(stashes.len(), 3);
    assert!(stashes[0].subject.contains("three"));
    assert!(stashes[1].subject.contains("renamed"));
    assert!(stashes[2].subject.contains("one"));
    assert_eq!(
        error_text(repo.rename_stash("stash@{9}", "x")),
        "Stash not found: stash@{9}"
    );
    assert_eq!(
        error_text(repo.rename_stash("HEAD", "x")),
        "Invalid stash reference: HEAD"
    );
    assert_eq!(
        error_text(repo.rename_stash("stash@{0}", " ")),
        "A stash name is required"
    );
}

#[test]
fn loads_multiple_stashes_and_shows_their_first_parent_changes() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "file", "base\n");
    git(root, &["add", "file"]);
    git(root, &["commit", "-m", "base"]);
    let repo = open(&dir);

    write(root, "file", "first\n");
    repo.stash(Some("first stash"), false).unwrap();
    write(root, "file", "second\n");
    write(root, "untracked.txt", "untracked stash content\n");
    repo.stash(Some("second stash"), true).unwrap();

    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    let refs: Vec<&str> = snapshot
        .stashes
        .iter()
        .map(|s| s.reference.as_str())
        .collect();
    assert_eq!(refs, ["stash@{0}", "stash@{1}"]);
    let stash_sha = snapshot.stashes[0].sha.clone();
    let files = repo.commit_files(&stash_sha, None).unwrap();
    let listed: Vec<(&str, FileState)> = files.iter().map(|f| (f.path.as_str(), f.state)).collect();
    assert_eq!(
        listed,
        [
            ("file", FileState::Modified),
            ("untracked.txt", FileState::Added)
        ]
    );
    let diff = |path: Option<&str>| {
        repo.diff(&DiffRequest {
            commit: Some(stash_sha.clone()),
            path: path.map(String::from),
            ..DiffRequest::default()
        })
        .unwrap()
    };
    assert!(diff(Some("file")).contains("+second"));
    let untracked = diff(Some("untracked.txt"));
    assert!(untracked.contains("new file mode"));
    assert!(untracked.contains("+untracked stash content"));
    assert!(diff(None).contains("diff --git a/untracked.txt b/untracked.txt"));
}

#[test]
fn rejects_empty_or_invalid_tag_names_before_creating_a_ref() {
    let dir = repo_dir();
    git(dir.path(), &["commit", "--allow-empty", "-m", "base"]);
    let repo = open(&dir);
    for name in ["", "   ", "invalid..name", "invalid~name"] {
        assert!(repo.create_tag(name, None).is_err(), "{name:?} should fail");
    }
    assert!(repo.create_tag("ok", Some("")).is_err());
    assert_eq!(git(dir.path(), &["tag", "--list"]), "");
}

#[test]
fn working_status_reports_the_same_working_state_as_a_full_snapshot() {
    let dir = repo_dir();
    let root = dir.path();
    write(root, "a.txt", "one\n");
    write(root, "b.txt", "two\n");
    let repo = open(&dir);
    repo.stage(&paths(&["a.txt"])).unwrap();
    repo.commit("initial").unwrap();
    write(root, "a.txt", "changed\n");
    repo.stage(&paths(&["a.txt"])).unwrap();
    write(root, "a.txt", "changed again\n");

    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    let status = repo.working_status().unwrap();
    assert_eq!(status.files, snapshot.files);
    assert_eq!(status.ahead, snapshot.ahead);
    assert_eq!(status.behind, snapshot.behind);
    assert_eq!(status.upstream, snapshot.upstream);
}

#[test]
fn history_is_ordered_newest_first_across_every_ref() {
    let dir = repo_dir();
    let root = dir.path();
    let commit = |name: &str, at: &str| {
        write(root, &format!("{name}.txt"), &format!("{name}\n"));
        git(root, &["add", &format!("{name}.txt")]);
        git_env(
            root,
            &["commit", "-m", name],
            &[("GIT_AUTHOR_DATE", at), ("GIT_COMMITTER_DATE", at)],
        );
    };
    commit("first", "2020-01-01T00:00:00+00:00");
    commit("second", "2020-01-02T00:00:00+00:00");
    git(root, &["switch", "-c", "side", "HEAD~1"]);
    commit("side", "2020-01-03T00:00:00+00:00");

    // The walk drops --date-order for speed, so assert the ordering it relies on.
    let commits = open(&dir).snapshot(DEFAULT_HISTORY_PAGE).unwrap().commits;
    assert_eq!(subjects(&commits), ["side", "second", "first"]);
}

#[test]
fn history_pages_report_whether_older_commits_remain() {
    let dir = repo_dir();
    let repo = open(&dir);
    for name in ["one", "two", "three", "four"] {
        commit_file(
            &repo,
            dir.path(),
            &format!("{name}.txt"),
            &format!("{name}\n"),
            name,
        );
    }
    let first = repo.commit_page(2, 0).unwrap();
    assert_eq!(subjects(&first.commits), ["four", "three"]);
    assert!(!first.complete);
    let second = repo.commit_page(4, 0).unwrap();
    assert_eq!(second.commits.len(), 4);
    assert!(second.complete);
    // A page larger than the history is still complete, without padding.
    let third = repo.commit_page(50, 0).unwrap();
    assert_eq!(third.commits.len(), 4);
    assert!(third.complete);
    let snapshot = repo.snapshot(2).unwrap();
    assert_eq!(snapshot.commits.len(), 2);
    assert!(!snapshot.commits_complete);
    // A skipped page continues the same walk, so the caller can append it to
    // what it already holds after checking the overlapping commit.
    let continued = repo.commit_page(3, 1).unwrap();
    assert_eq!(subjects(&continued.commits), ["three", "two", "one"]);
    assert!(continued.complete);
    assert_eq!(continued.commits[0].sha, first.commits[1].sha);
}

#[test]
fn sequential_pages_continue_one_walk_and_match_skipped_reads() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    for i in 0..12 {
        commit_file(
            &repo,
            root,
            &format!("f{i}.txt"),
            &format!("{i}\n"),
            &format!("c{i}"),
        );
    }
    let all = repo.commit_page(50, 0).unwrap().commits;
    assert_eq!(all.len(), 12);
    // Page forward the way the history view does, overlapping by one commit.
    let mut paged: Vec<String> = Vec::new();
    let mut loaded = 0;
    loop {
        let page = repo.commit_page(3, loaded.max(1) - 1).unwrap();
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
    let back = repo.commit_page(2, 1).unwrap();
    assert_eq!(back.commits[0].sha, all[1].sha);
    assert_eq!(back.commits[1].sha, all[2].sha);
    assert!(!back.complete);
    // Bodies survive record-by-record parsing, so a page is not just SHAs.
    assert_eq!(all[0].subject, "c11");

    // Refreshing restarts the walk against the new tip.
    commit_file(&repo, root, "extra.txt", "extra\n", "extra");
    let snapshot = repo.snapshot(4).unwrap();
    assert_eq!(snapshot.commits[0].subject, "extra");
    let next = repo.commit_page(4, 3).unwrap();
    assert_eq!(next.commits[0].sha, snapshot.commits[3].sha);
    assert_eq!(subjects(&next.commits), ["c9", "c8", "c7", "c6"]);
    repo.dispose();
    // Disposing only ends the walk; later pages still read correctly.
    assert_eq!(repo.commit_page(2, 0).unwrap().commits[0].subject, "extra");
}

#[test]
fn an_empty_repository_reports_complete_empty_history() {
    let dir = temp_repo();
    let repo = open(&dir);
    let page = repo.commit_page(250, 0).unwrap();
    assert!(page.commits.is_empty());
    assert!(page.complete);
    // Repeated reads of an empty walk stay empty rather than restarting badly.
    let again = repo.commit_page(10, 5).unwrap();
    assert!(again.commits.is_empty());
    assert!(again.complete);
    repo.dispose();
}

#[test]
fn applies_and_discards_patches_through_stdin() {
    let dir = repo_dir();
    let root = dir.path();
    let repo = open(&dir);
    commit_file(&repo, root, "file", "one\n", "base");
    write(root, "file", "one\ntwo\n");
    let patch = git(root, &["diff"]) + "\n";
    // Reset the working tree, then stage the change from the patch alone.
    git(root, &["checkout", "--", "file"]);
    repo.apply_patch(&patch, false).unwrap();
    assert!(git(root, &["diff", "--cached"]).contains("+two"));
    repo.apply_patch(&patch, true).unwrap();
    assert_eq!(git(root, &["diff", "--cached"]), "");
    // A patch that does not apply reports Git's error.
    assert!(matches!(
        repo.apply_patch("not a patch\n", false),
        Err(GitError::Command(_))
    ));

    write(root, "file", "one\ntwo\n");
    repo.discard_patch(&patch).unwrap();
    assert_eq!(read(root, "file"), "one\n");
}

#[test]
fn remote_failures_without_credentials_block_background_fetch() {
    let dir = repo_dir();
    git(dir.path(), &["commit", "--allow-empty", "-m", "base"]);
    // A missing credential helper makes Git report that prompts are disabled.
    git(
        dir.path(),
        &["remote", "add", "origin", "https://127.0.0.1:1/nope.git"],
    );
    let repo = open(&dir);
    let error = repo.fetch(Some("origin"), None).err().unwrap();
    // The connection fails before authentication, so this is a plain command
    // error and must not mark the repository as blocked.
    assert!(matches!(error, GitError::Command(_)));
    assert!(!repo.auth_blocked());
}

#[test]
fn watch_paths_resolve_real_directories_for_a_linked_worktree() {
    let dir = repo_dir();
    git(dir.path(), &["commit", "--allow-empty", "-m", "base"]);
    let linked = TempDir::new("tuig-watch-linked");
    git(
        dir.path(),
        &[
            "worktree",
            "add",
            "--detach",
            linked.path().to_str().unwrap(),
            "HEAD",
        ],
    );
    let main = open(&dir).watch_paths().unwrap().unwrap();
    let paths = open(&linked).watch_paths().unwrap().unwrap();
    let real = |p: &Path| {
        std::fs::canonicalize(p)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    };
    assert_eq!(paths.work_tree, real(linked.path()));
    assert_eq!(paths.common_dir, real(&dir.path().join(".git")));
    assert_eq!(main.git_dir, main.common_dir);
    assert_ne!(paths.git_dir, paths.common_dir);
}

#[test]
fn remote_url_reads_origin_and_is_absent_without_one() {
    let dir = repo_dir();
    let repo = open(&dir);
    assert_eq!(repo.remote_url(), None);
    git(
        dir.path(),
        &["remote", "add", "origin", "https://example.com/a.git"],
    );
    assert_eq!(
        repo.remote_url().as_deref(),
        Some("https://example.com/a.git")
    );
}

#[test]
fn parses_commit_times_with_offsets() {
    assert_eq!(parse_instant("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_instant("1970-01-01T10:00:00+10:00"), Some(0));
    assert_eq!(
        parse_instant("2026-01-02T00:00:00+00:00"),
        Some(1_767_312_000)
    );
    assert_eq!(parse_instant("1969-12-31T23:00:00-01:00"), Some(0));
    assert_eq!(parse_instant("not a date"), None);
}

#[test]
fn adds_locks_and_removes_worktrees() {
    let dir = repo_dir();
    git(dir.path(), &["commit", "--allow-empty", "-m", "base"]);
    let repo = open(&dir);
    let parent = TempDir::new("tuig-wt-parent");
    let path = parent.path().join("feature").to_string_lossy().into_owned();
    repo.add_worktree(&path, Some("feature"), true).unwrap();
    repo.lock_worktree(&path, true, Some("busy")).unwrap();
    let snapshot = repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap();
    let linked = snapshot
        .worktrees
        .iter()
        .find(|w| w.branch.as_deref() == Some("feature"))
        .unwrap();
    assert_eq!(linked.locked.as_deref(), Some("busy"));
    repo.lock_worktree(&path, false, None).unwrap();
    repo.remove_worktree(&path, false).unwrap();
    assert_eq!(
        repo.snapshot(DEFAULT_HISTORY_PAGE).unwrap().worktrees.len(),
        1
    );
}
