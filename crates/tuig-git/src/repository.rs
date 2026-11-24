//! The repository service: the `GitRepository` interface from `src/git/types.ts`
//! as a trait, and the concrete service from `src/git/repository.ts`.
//!
//! Differences from the TypeScript version:
//! - Calls are async on tokio. `snapshot`, `working_status`, and `open` run
//!   their independent Git commands with `tokio::join!`, like the
//!   `Promise.all` calls. The traits use `async_trait`, so
//!   `Arc<dyn GitRepository>` works and every future is `Send`.
//! - Optional interface members have trait defaults. `commit_page` has no
//!   fallback and fails with `ErrorKind::Unsupported`. `watch_paths` returns
//!   `None` when a repository cannot be watched.
//! - Checks that threw a plain `Error` or `RangeError` return `GitError::Invalid`
//!   (bad argument) or `GitError::Io` with kind `Other` (bad repository state).
//! - TypeScript identifies the snapshot a history signature belongs to by the
//!   `commits` array object. Rust snapshots are plain values, so the service
//!   keys the signature by the tip commit (its SHA and decorations). A refresh
//!   reuses history only for a snapshot whose tip matches the signature the
//!   service stored last for that tip. A reused refresh returns a copy of the
//!   previous commits.
//! - Commit times sort by their parsed instant. A time that does not parse
//!   sorts last.
//! - `refresh_snapshot`, `commit_page`, and `snapshot` take an explicit limit.
//!   Use [`DEFAULT_HISTORY_PAGE`] for the TypeScript default.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, PoisonError};

use async_trait::async_trait;
use regex::Regex;

use crate::commit_walk::{CommitWalk, HISTORY_MUTATING, LOG_FORMAT};
use crate::parsers::{
    parse_log, parse_name_status, parse_refs, parse_stashes, parse_status, parse_submodule_names,
    parse_submodules, parse_tracking, parse_worktrees,
};
use crate::process::{
    CancelToken, GitAuthError, GitError, NotGitRepositoryError, NotRepositoryProblem, RunOptions,
    nearby_repositories, run_git_with,
};
use crate::remote_errors::{
    RemoteOperation, classify_remote_auth_failure, describe_remote_auth_failure,
};
use crate::types::{
    ChangedFile, CommandResult, Commit, CommitPage, DiffRequest, EarlyHistory, FileState,
    HistoryHead, LineBlame, RepositorySnapshot, RepositoryWatchPaths, ResetMode, UndoPreview,
    WorkingStatus, Worktree,
};
use crate::undo;

pub type Result<T> = std::result::Result<T, GitError>;

/// Commits in the first page of history, before any paging.
pub const DEFAULT_HISTORY_PAGE: usize = 250;

/// The operations the UI needs from a repository. Port of the `GitRepository`
/// interface in `src/git/types.ts`.
#[async_trait]
pub trait GitRepository: Send + Sync {
    /// Cancel repository-specific background work when no tab owns this service.
    async fn dispose(&self) {}
    fn root(&self) -> &str;
    /// The main checkout's root, when this repository is a linked worktree.
    fn main_worktree(&self) -> Option<&str> {
        None
    }
    async fn remote_url(&self) -> Option<String> {
        None
    }
    /// Set while remote commands fail for missing credentials. Background fetch pauses.
    fn auth_blocked(&self) -> bool {
        false
    }
    /// Directories to watch for changes. `None` means callers fall back to polling.
    async fn watch_paths(&self) -> Result<Option<RepositoryWatchPaths>> {
        Ok(None)
    }
    async fn snapshot(&self, limit: usize) -> Result<RepositorySnapshot>;
    /// Like `snapshot`, and calls `early` with the history page, refs, and
    /// HEAD as soon as they are read, before working-tree status finishes.
    /// `early` runs at most once, on the task that runs the snapshot. The
    /// default never calls it.
    async fn snapshot_early(
        &self,
        limit: usize,
        early: EarlyHistory,
    ) -> Result<RepositorySnapshot> {
        let _ = early;
        self.snapshot(limit).await
    }
    /// Defaults to a full snapshot.
    async fn refresh_snapshot(
        &self,
        previous: &RepositorySnapshot,
        limit: usize,
    ) -> Result<RepositorySnapshot> {
        let _ = previous;
        self.snapshot(limit).await
    }
    /// History-only read, used to extend the loaded page without paying for
    /// the rest of a snapshot. Fails with `ErrorKind::Unsupported` by default.
    async fn commit_page(&self, limit: usize, skip: usize) -> Result<CommitPage> {
        let _ = (limit, skip);
        Err(GitError::Io(std::io::Error::new(
            ErrorKind::Unsupported,
            "this repository cannot page history",
        )))
    }
    /// Fast path for refreshes that cannot have changed history. Defaults to a
    /// full snapshot of one commit.
    async fn working_status(&self) -> Result<WorkingStatus> {
        let snapshot = self.snapshot(1).await?;
        Ok(WorkingStatus {
            upstream: snapshot.upstream,
            ahead: snapshot.ahead,
            behind: snapshot.behind,
            files: snapshot.files,
        })
    }
    /// Commits that changed one path, newest first, following renames.
    async fn file_history(&self, path: &str, start: Option<&str>) -> Result<Vec<Commit>>;
    /// Commits that changed one line's ancestry, newest first. `start` defaults to HEAD.
    async fn line_history(
        &self,
        path: &str,
        line: usize,
        start: Option<&str>,
    ) -> Result<Vec<Commit>>;
    /// Finds the commit responsible for one 1-based line at a commit or HEAD.
    async fn blame_line(&self, path: &str, line: usize, commit: Option<&str>) -> Result<LineBlame>;
    async fn diff(&self, request: &DiffRequest) -> Result<String>;
    async fn commit_files(&self, sha: &str, base: Option<&str>) -> Result<Vec<ChangedFile>>;
    async fn stage(&self, paths: &[String]) -> Result<()>;
    async fn unstage(&self, paths: &[String]) -> Result<()>;
    async fn apply_patch(&self, patch: &str, reverse: bool) -> Result<()>;
    /// Reverses a partial working-tree patch without changing the index.
    async fn discard_patch(&self, patch: &str) -> Result<()>;
    async fn discard_all(&self) -> Result<()>;
    /// Restores the given paths in the working tree, dropping unstaged edits.
    async fn discard(&self, paths: &[String]) -> Result<()>;
    async fn commit(&self, message: &str) -> Result<()>;
    async fn amend_commit(&self, message: &str) -> Result<()>;
    async fn reword_commit(&self, sha: &str, message: &str) -> Result<()>;
    async fn switch_branch(&self, name: &str) -> Result<()>;
    async fn checkout_commit(&self, sha: &str) -> Result<()>;
    async fn checkout_remote_branch(&self, local: &str, remote: &str, reset: bool) -> Result<()>;
    async fn get_undo_preview(&self) -> Result<UndoPreview>;
    async fn undo(&self, preview: &UndoPreview) -> Result<()>;
    async fn reset_to(&self, sha: &str, mode: ResetMode) -> Result<()>;
    async fn rebase_onto(&self, reference: &str) -> Result<()>;
    async fn cherry_pick(&self, sha: &str) -> Result<()>;
    /// Creates a lightweight tag at `target` (or HEAD when omitted).
    async fn create_tag(&self, name: &str, target: Option<&str>) -> Result<()>;
    async fn push_tag(
        &self,
        name: &str,
        remote: Option<&str>,
        cancel: Option<&CancelToken>,
    ) -> Result<()>;
    async fn delete_tag(&self, name: &str) -> Result<()>;
    async fn create_branch(
        &self,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<()>;
    async fn delete_branch(&self, name: &str, force: bool, remote: bool) -> Result<()>;
    async fn delete_remote_branch(&self, name: &str, cancel: Option<&CancelToken>) -> Result<()>;
    async fn fetch(&self, remote: Option<&str>, cancel: Option<&CancelToken>) -> Result<()>;
    async fn pull(&self, rebase: bool, cancel: Option<&CancelToken>) -> Result<()>;
    async fn push(
        &self,
        remote: Option<&str>,
        set_upstream: bool,
        cancel: Option<&CancelToken>,
    ) -> Result<()>;
    async fn stash(&self, message: Option<&str>, include_untracked: bool) -> Result<()>;
    async fn apply_stash(&self, reference: &str, pop: bool) -> Result<()>;
    async fn pop_stash(&self, reference: &str) -> Result<()>;
    async fn drop_stash(&self, reference: &str) -> Result<()>;
    async fn rename_stash(&self, reference: &str, message: &str) -> Result<()>;
    async fn update_submodule(&self, path: &str, init: bool) -> Result<()>;
    async fn sync_submodule(&self, path: &str) -> Result<()>;
    async fn add_worktree(
        &self,
        path: &str,
        branch: Option<&str>,
        create_branch: bool,
    ) -> Result<()>;
    async fn remove_worktree(&self, path: &str, force: bool) -> Result<()>;
    async fn lock_worktree(&self, path: &str, lock: bool, reason: Option<&str>) -> Result<()>;
}

/// An error for a rejected argument (the TypeScript `Error` or `RangeError`).
fn invalid(message: &str) -> GitError {
    GitError::Invalid(message.to_string())
}

/// An error for a repository state that blocks the request.
fn refused(message: impl Into<String>) -> GitError {
    GitError::Io(std::io::Error::other(message.into()))
}

/// JS truthiness for an optional string: `None` and "" are both absent.
fn present(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

fn empty_result() -> CommandResult {
    CommandResult::default()
}

/// Drop untracked entries that are linked worktrees of this repository.
///
/// A worktree checked out inside the repository shows up in `git status` as an
/// untracked "dir/" entry. The worktrees section already lists it, and staging
/// or discarding it from the changes list would add a gitlink or delete the
/// other checkout.
fn without_linked_worktrees(
    files: Vec<ChangedFile>,
    worktrees: &[Worktree],
    root: &str,
) -> Vec<ChangedFile> {
    let nested: Vec<String> = worktrees
        .iter()
        .filter_map(|worktree| {
            let relative = Path::new(&worktree.path).strip_prefix(root).ok()?;
            let text = relative.to_string_lossy();
            if text.is_empty() {
                return None;
            }
            let parts: Vec<String> = relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            Some(format!("{}/", parts.join("/")))
        })
        .collect();
    if nested.is_empty() {
        return files;
    }
    files
        .into_iter()
        .filter(|file| file.state != FileState::Untracked || !nested.contains(&file.path))
        .collect()
}

/// The reads that wait on `git status`.
struct StatusPart {
    status: String,
    worktrees: String,
    submodules: String,
    submodule_names: HashMap<String, String>,
    shallow: Vec<Vec<u8>>,
}

/// `for-each-ref` output filtered to local and remote branch refs.
fn branch_refs(all_refs: &str) -> String {
    all_refs
        .split('\0')
        .filter(|record| {
            let record = record.strip_prefix('\n').unwrap_or(record);
            record.starts_with("refs/heads/") || record.starts_with("refs/remotes/")
        })
        .collect::<Vec<_>>()
        .join("\0")
}

struct SnapshotMetadata {
    status: String,
    /// Status output filtered to local and remote branch refs.
    refs: String,
    stash: String,
    worktrees: String,
    submodules: String,
    submodule_names: HashMap<String, String>,
    branch: Option<String>,
    head_sha: Option<String>,
    history_signature: Vec<u8>,
}

pub struct GitRepositoryService {
    root: String,
    main_worktree: Option<String>,
    shallow_metadata_paths: Vec<String>,
    walk: CommitWalk,
    /// Signature of the refs and metadata each recent snapshot was built from,
    /// keyed by [`tip_key`].
    history_signatures: Mutex<HashMap<u64, Vec<u8>>>,
    auth_blocked: AtomicBool,
}

/// Identifies the snapshot a signature belongs to by its newest commit.
fn tip_key(commits: &[Commit]) -> u64 {
    let mut hasher = DefaultHasher::new();
    if let Some(tip) = commits.first() {
        tip.sha.hash(&mut hasher);
        tip.decorations.hash(&mut hasher);
    }
    hasher.finish()
}

/// Seconds since the Unix epoch for an ISO 8601 time like
/// `2026-01-01T00:00:00+10:00`, or `None` when it does not parse.
fn parse_instant(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b' ') {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> { text.get(range)?.parse().ok() };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.chars().take_while(char::is_ascii_digit).count();
        rest = &fraction[digits..];
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = rest[1..].chars().filter(char::is_ascii_digit).collect();
            let hours: i64 = digits.get(0..2)?.parse().ok()?;
            let minutes: i64 = digits.get(2..4).map_or(Some(0), |m| m.parse().ok())?;
            sign * (hours * 3600 + minutes * 60)
        }
    };
    // Days from civil date (proleptic Gregorian), after Howard Hinnant.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + hour * 3600 + minute * 60 + second - offset)
}

static STASH_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:WIP on|On) [^:]*: ").expect("static regex"));
static BLAME_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^([0-9a-f]+) (\d+) (\d+)(?: \d+)?$").expect("static regex"));

impl GitRepositoryService {
    /// Opens the repository that contains `path`.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let shown = path.to_string_lossy().into_owned();
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Err(NotGitRepositoryError::new(
                    &shown,
                    suggestions(path, false).await,
                    NotRepositoryProblem::Missing,
                )
                .into());
            }
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_dir() {
            return Err(NotGitRepositoryError::new(
                &shown,
                Vec::new(),
                NotRepositoryProblem::NotDirectory,
            )
            .into());
        }
        let top = match run_git_with(&["rev-parse", "--show-toplevel"], &RunOptions::in_dir(path))
            .await
        {
            Ok(result) => result,
            Err(GitError::Command(error))
                if error
                    .result
                    .stderr
                    .to_lowercase()
                    .contains("not a git repository") =>
            {
                return Err(NotGitRepositoryError::new(
                    &shown,
                    suggestions(path, true).await,
                    NotRepositoryProblem::NotRepository,
                )
                .into());
            }
            Err(error) => return Err(error),
        };
        let root = top.stdout.trim().to_string();
        let options = RunOptions::in_dir(&root);
        let (metadata, worktrees) = tokio::join!(
            run_git_with(
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-path",
                    "shallow",
                    "--git-path",
                    "info/grafts",
                ],
                &options,
            ),
            run_git_with(&["worktree", "list", "--porcelain"], &options),
        );
        let metadata = metadata?;
        let worktrees = worktrees?;
        // Git always lists the main worktree first.
        let main = parse_worktrees(&worktrees.stdout)
            .into_iter()
            .next()
            .map(|w| w.path)
            .filter(|main| !main.is_empty() && *main != root);
        Ok(Self {
            walk: CommitWalk::new(&root),
            root,
            main_worktree: main,
            shallow_metadata_paths: metadata
                .stdout
                .trim()
                .split('\n')
                .map(String::from)
                .collect(),
            history_signatures: Mutex::new(HashMap::new()),
            auth_blocked: AtomicBool::new(false),
        })
    }

    fn options(&self) -> RunOptions {
        RunOptions::in_dir(&self.root)
    }

    /// Runs Git in the root. Subcommands that can move history first drop the
    /// open walk.
    pub(crate) async fn git<S: AsRef<str>>(&self, args: &[S]) -> Result<CommandResult> {
        self.git_with(args, self.options()).await
    }

    async fn git_with<S: AsRef<str>>(
        &self,
        args: &[S],
        options: RunOptions,
    ) -> Result<CommandResult> {
        let subcommand = args
            .iter()
            .map(AsRef::as_ref)
            .find(|arg| !arg.starts_with('-'));
        if subcommand.is_some_and(|s| HISTORY_MUTATING.contains(&s)) {
            self.invalidate_history().await;
        }
        run_git_with(args, &options).await
    }

    pub(crate) async fn git_env<S: AsRef<str>>(
        &self,
        args: &[S],
        env: &[(&str, &str)],
    ) -> Result<CommandResult> {
        let mut options = self.options();
        options.env = env
            .iter()
            .map(|(k, v)| (k.to_string(), Some(v.to_string())))
            .collect();
        self.git_with(args, options).await
    }

    async fn git_limited<S: AsRef<str>>(
        &self,
        args: &[S],
        cancel: Option<&CancelToken>,
        max_bytes: Option<usize>,
    ) -> Result<CommandResult> {
        let mut options = self.options();
        options.cancel = cancel.cloned();
        options.max_bytes = max_bytes;
        self.git_with(args, options).await
    }

    /// Runs Git without the history invalidation of [`Self::git`].
    async fn git_read<S: AsRef<str>>(&self, args: &[S]) -> Result<CommandResult> {
        run_git_with(args, &self.options()).await
    }

    async fn invalidate_history(&self) {
        self.walk.invalidate().await;
    }

    #[cfg(test)]
    pub(crate) async fn walk_starts(&self) -> usize {
        self.walk.starts().await
    }

    fn signatures(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Vec<u8>>> {
        self.history_signatures
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn remember_signature(&self, commits: &[Commit], signature: Vec<u8>) {
        let mut signatures = self.signatures();
        if signatures.len() >= 16 {
            signatures.clear();
        }
        signatures.insert(tip_key(commits), signature);
    }

    /// Builds a snapshot. The history page, refs, and HEAD read in parallel
    /// with `git status`. With `early`, they go to the callback when they are
    /// ready, ahead of the status result.
    async fn load_snapshot(
        &self,
        limit: usize,
        early: Option<EarlyHistory>,
    ) -> Result<RepositorySnapshot> {
        // A snapshot is the refresh point for new history, so the walk restarts
        // from the tip rather than continuing one taken before a fetch or commit.
        self.invalidate_history().await;
        let wanted = limit.max(1);
        // The walk does not depend on status or the stash list, so it starts
        // at once. The stash list feeds both the metadata and the stash rows.
        let stash_rows = async {
            let stash = self.read_stash_list().await;
            let shas = parse_stashes(&stash).into_iter().map(|s| s.sha).collect();
            let tips = self.stash_commits(shas).await;
            (stash, tips)
        };
        let head_sha = async {
            // Fails in a repository with no commits, which has no HEAD to report.
            self.git_read(&["rev-parse", "-q", "--verify", "HEAD"])
                .await
                .ok()
                .map(|out| out.stdout.trim().to_owned())
                .filter(|sha| !sha.is_empty())
        };
        let history = async {
            let ((stash, tips), walked, all_refs, head_sha) = tokio::join!(
                stash_rows,
                self.walk.read(0, wanted + 1),
                self.read_all_refs(),
                head_sha,
            );
            let all_refs = all_refs?.stdout;
            let mut walked = walked?;
            if !tips.is_empty() {
                // The walk read above covered `wanted + 1`. Each stash row can
                // push one more ordinary commit out of the page.
                walked.extend(self.walk.read(walked.len(), tips.len()).await?);
            }
            let log = merge_page(tips, walked, wanted, 0);
            if let Some(early) = early {
                let branches = parse_refs(&branch_refs(&all_refs));
                early(HistoryHead {
                    root: self.root.clone(),
                    head_sha,
                    branch: branches
                        .iter()
                        .find(|branch| branch.current && !branch.remote)
                        .map(|branch| branch.name.clone()),
                    branches,
                    stashes: parse_stashes(&stash),
                    commits: log.commits.clone(),
                    commits_complete: log.complete,
                });
            }
            Ok::<_, GitError>((all_refs, stash, log))
        };
        let (history, part) = tokio::join!(history, self.read_status_part());
        let (all_refs, stash, log) = history?;
        let mut metadata = Self::metadata_from(all_refs, part?);
        metadata.stash = stash;
        let signature = metadata.history_signature.clone();
        let snapshot = self.build_snapshot(metadata, log.commits, log.complete);
        self.remember_signature(&snapshot.commits, signature);
        Ok(snapshot)
    }

    /// Reads everything in a snapshot except the stash list and the commit
    /// rows, so a caller can run those beside it.
    ///
    /// Every call here is read-only. They go through `git_read` so they cannot
    /// drop a history walk that runs at the same time.
    async fn read_snapshot_metadata(&self) -> Result<SnapshotMetadata> {
        let (metadata, stash) = tokio::join!(self.read_snapshot_core(), self.read_stash_list());
        let mut metadata = metadata?;
        metadata.stash = stash;
        Ok(metadata)
    }

    /// Raw `stash list` output with the fields `parse_stashes` reads.
    async fn read_stash_list(&self) -> String {
        self.git_read(&["stash", "list", "--format=%gd%x09%H%x09%cr%x09%s%x00"])
            .await
            .map(|out| out.stdout)
            .unwrap_or_default()
    }

    async fn read_snapshot_core(&self) -> Result<SnapshotMetadata> {
        let (all_refs, part) = tokio::join!(self.read_all_refs(), self.read_status_part());
        Ok(Self::metadata_from(all_refs?.stdout, part?))
    }

    /// Every ref with its object name and `%(HEAD)` mark, NUL-terminated.
    async fn read_all_refs(&self) -> Result<CommandResult> {
        self.git_read(&[
            "for-each-ref",
            // %(HEAD) marks the checked-out local branch. Emit the
            // record terminator explicitly: for-each-ref otherwise
            // separates records with newlines, which makes the
            // tabular parser see all refs as one row.
            "--format=%(refname)\t%(objectname)\t%(HEAD)%00",
        ])
        .await
    }

    /// The slow half of a snapshot: working-tree status and the reads that
    /// run beside it.
    async fn read_status_part(&self) -> Result<StatusPart> {
        // Polling must not take the index lock: the auto-refresh would
        // otherwise collide with a Git command the user is running elsewhere.
        let status = self.git_read(&[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            // List each untracked file. The default collapses a
            // directory into a single "dir/" entry that has no
            // name or diff in the UI.
            "--untracked-files=all",
            "--branch",
            "-z",
        ]);
        let worktrees = self.git_read(&["worktree", "list", "--porcelain"]);
        // Only `submodule status` needs the names, so the config read chains
        // inside this future instead of holding back the others.
        let submodules = async {
            let config = self
                .git_read(&[
                    "config",
                    "--null",
                    "--file",
                    ".gitmodules",
                    "--get-regexp",
                    "^submodule\\..*\\.path$",
                ])
                .await
                .unwrap_or_else(|_| empty_result());
            let names = parse_submodule_names(&config.stdout);
            if names.is_empty() {
                return (names, empty_result());
            }
            let status = self
                .git_read(&["submodule", "status", "--recursive"])
                .await
                .unwrap_or_else(|_| empty_result());
            (names, status)
        };
        let shallow = async { self.read_shallow_metadata() };
        let (status, worktrees, (submodule_names, submodules), shallow) =
            tokio::join!(status, worktrees, submodules, shallow);
        Ok(StatusPart {
            status: status?.stdout,
            worktrees: worktrees?.stdout,
            submodules: submodules.stdout,
            submodule_names,
            shallow: shallow?,
        })
    }

    fn metadata_from(all_refs: String, part: StatusPart) -> SnapshotMetadata {
        let StatusPart {
            status,
            worktrees,
            submodules,
            submodule_names,
            shallow,
        } = part;
        let status_records: Vec<&str> = status.split('\0').collect();
        let branch_head = status_records
            .iter()
            .find_map(|r| r.strip_prefix("# branch.head "))
            .filter(|b| !b.is_empty() && *b != "(detached)")
            .map(String::from);
        let head_sha = status_records
            .iter()
            .find_map(|r| r.strip_prefix("# branch.oid "))
            .filter(|s| !s.is_empty() && *s != "(initial)" && *s != "(unknown)")
            .map(String::from);
        let worktree_heads = worktrees
            .split('\n')
            .filter(|line| line.starts_with("HEAD ") || line.starts_with("branch "))
            .collect::<Vec<_>>()
            .join("\n");
        let head_records = status_records
            .iter()
            .filter(|r| r.starts_with("# branch.oid ") || r.starts_with("# branch.head "))
            .copied()
            .collect::<Vec<_>>()
            .join("\0");
        let mut signature: Vec<u8> = Vec::new();
        let mut part = |bytes: &[u8]| {
            if !signature.is_empty() {
                signature.push(0x1e);
            }
            signature.extend_from_slice(bytes);
        };
        part(all_refs.as_bytes());
        part(head_records.as_bytes());
        part(worktree_heads.as_bytes());
        for contents in &shallow {
            part(contents);
        }
        let refs = branch_refs(&all_refs);
        SnapshotMetadata {
            status,
            refs,
            stash: String::new(),
            worktrees,
            submodules,
            submodule_names,
            branch: branch_head,
            head_sha,
            history_signature: signature,
        }
    }

    fn read_shallow_metadata(&self) -> Result<Vec<Vec<u8>>> {
        self.shallow_metadata_paths
            .iter()
            .map(|path| match std::fs::read(path) {
                Ok(contents) => Ok(contents),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(Vec::new()),
                Err(error) => Err(error.into()),
            })
            .collect()
    }

    fn build_snapshot(
        &self,
        metadata: SnapshotMetadata,
        commits: Vec<Commit>,
        commits_complete: bool,
    ) -> RepositorySnapshot {
        let tracking = parse_tracking(&metadata.status);
        let worktrees = parse_worktrees(&metadata.worktrees);
        RepositorySnapshot {
            root: self.root.clone(),
            head_sha: metadata.head_sha,
            branch: metadata.branch,
            upstream: tracking.upstream,
            ahead: tracking.ahead,
            behind: tracking.behind,
            files: without_linked_worktrees(parse_status(&metadata.status), &worktrees, &self.root),
            branches: parse_refs(&metadata.refs),
            stashes: parse_stashes(&metadata.stash),
            worktrees,
            submodules: parse_submodules(&metadata.submodules, Some(&metadata.submodule_names)),
            commits,
            commits_complete,
        }
    }

    /// One history row per stash: the WIP tip with only its first parent, so
    /// the graph draws a single lane back to the base commit instead of extra
    /// lanes for the internal index/untracked commits the walk excludes.
    ///
    /// Read-only: uses `git_read` so the `stash` subcommand does not trip the
    /// history-mutating invalidation that would drop the held-open walk.
    async fn stash_tip_commits(&self) -> Vec<Commit> {
        let Ok(list) = self.git_read(&["stash", "list", "--format=%H"]).await else {
            return Vec::new();
        };
        let shas: Vec<String> = list
            .stdout
            .split('\n')
            .map(|sha| sha.trim().to_string())
            .filter(|sha| !sha.is_empty())
            .collect();
        self.stash_commits(shas).await
    }

    /// Stash tip rows for known SHAs, newest stash first.
    async fn stash_commits(&self, shas: Vec<String>) -> Vec<Commit> {
        if shas.is_empty() {
            return Vec::new();
        }
        let mut args: Vec<&str> = vec!["log", "--no-walk", "--decorate", "-z", LOG_FORMAT];
        args.extend(shas.iter().map(String::as_str));
        let Ok(out) = self.git_read(&args).await else {
            return Vec::new();
        };
        let mut tips: Vec<Commit> = parse_log(&out.stdout)
            .into_iter()
            .map(|mut commit| {
                commit.parents.truncate(1);
                commit
            })
            .collect();
        let order = |sha: &str| shas.iter().position(|s| s == sha).unwrap_or(0);
        tips.sort_by_key(|tip| order(&tip.sha));
        tips
    }

    fn validate_history_path(path: &str) -> Result<()> {
        if path.is_empty() || path.contains('\0') {
            return Err(invalid("A file path is required"));
        }
        Ok(())
    }

    fn validate_commit_ref(sha: &str) -> Result<()> {
        if sha.trim().is_empty() || sha.contains('\0') || sha.starts_with('-') {
            return Err(invalid("A commit is required"));
        }
        Ok(())
    }

    fn validate_line(line: usize) -> Result<()> {
        if line < 1 {
            return Err(invalid("A positive 1-based line number is required"));
        }
        Ok(())
    }

    async fn validate_tag_name(&self, name: &str) -> Result<()> {
        if name.trim().is_empty() || name.contains('\0') {
            return Err(invalid("A tag name is required"));
        }
        self.git(&[
            "check-ref-format",
            "--allow-onelevel",
            &format!("refs/tags/{name}"),
        ])
        .await?;
        Ok(())
    }

    fn validate_submodule_path(path: &str) -> Result<()> {
        if path.trim().is_empty() || path.contains('\0') {
            return Err(invalid("A submodule path is required"));
        }
        Ok(())
    }

    async fn sync_submodules(&self) -> Result<()> {
        self.git(&["submodule", "sync", "--recursive"]).await?;
        self.git(&["submodule", "update", "--init", "--recursive"])
            .await?;
        Ok(())
    }

    /// Returns the resolved commit, its parents, and a stash's untracked-files parent.
    async fn commit_details(
        &self,
        sha: &str,
        cancel: Option<&CancelToken>,
    ) -> Result<(String, Vec<String>, Option<String>)> {
        Self::validate_commit_ref(sha)?;
        let shown = self
            .git_limited(
                &[
                    "show",
                    "-s",
                    "--format=%H%x00%P",
                    "--end-of-options",
                    &format!("{sha}^{{commit}}"),
                ],
                cancel,
                None,
            )
            .await?;
        let text = shown.stdout.trim();
        let mut fields = text.split('\0');
        let resolved = fields.next().unwrap_or("").to_string();
        let parents: Vec<String> = fields
            .next()
            .unwrap_or("")
            .split_whitespace()
            .map(String::from)
            .collect();
        let mut untracked_parent = None;
        if parents.len() == 3 {
            let stash_shas = self
                .git_limited(
                    &["reflog", "show", "--format=%H", "refs/stash"],
                    cancel,
                    None,
                )
                .await
                .map(|r| r.stdout)
                .unwrap_or_default();
            let third_parents = self
                .git_limited(&["show", "-s", "--format=%P", &parents[2]], cancel, None)
                .await?
                .stdout
                .trim()
                .to_string();
            // Only stash commits currently named by the stash reflog get the
            // special third-parent treatment. This avoids reinterpreting
            // arbitrary octopus merges, while the parentless third commit is
            // Git's untracked tree.
            if stash_shas.split('\n').any(|s| s == resolved) && third_parents.is_empty() {
                untracked_parent = Some(parents[2].clone());
            }
        }
        Ok((resolved, parents, untracked_parent))
    }

    async fn comparison_diff(&self, r: &DiffRequest) -> Result<String> {
        let (Some(base), Some(target)) = (present(r.base.as_deref()), present(r.target.as_deref()))
        else {
            return Err(invalid("Both comparison commits are required"));
        };
        Self::validate_commit_ref(base)?;
        Self::validate_commit_ref(target)?;
        let mut args: Vec<String> = vec!["diff".into(), "--no-ext-diff".into()];
        args.extend(context_flag(r));
        args.extend(["--end-of-options", base, target, "--"].map(String::from));
        args.extend(diff_paths(r));
        Ok(self
            .git_limited(&args, r.cancel.as_ref(), r.max_bytes)
            .await?
            .stdout)
    }

    async fn commit_diff(&self, r: &DiffRequest, commit: &str) -> Result<String> {
        let (resolved, parents, untracked_parent) =
            self.commit_details(commit, r.cancel.as_ref()).await?;
        let path = present(r.path.as_deref());
        let mut args: Vec<String> = Vec::new();
        if let Some(parent) = parents.first() {
            args.extend(["diff".into(), "--no-ext-diff".into()]);
            args.extend(context_flag(r));
            args.push(parent.clone());
            args.push(resolved.clone());
        } else {
            args.extend(["show".into(), "--format=".into(), "--no-ext-diff".into()]);
            args.extend(context_flag(r));
            args.push(resolved.clone());
        }
        args.push("--".into());
        args.extend(path.map(String::from));
        let tracked = self
            .git_limited(&args, r.cancel.as_ref(), r.max_bytes)
            .await?
            .stdout;
        let Some(untracked_parent) = untracked_parent else {
            return Ok(tracked);
        };
        let mut args: Vec<String> = vec!["show".into(), "--format=".into(), "--no-ext-diff".into()];
        args.extend(context_flag(r));
        args.push(untracked_parent);
        args.push("--".into());
        args.extend(path.map(String::from));
        let remaining = r.max_bytes.map(|max| max.saturating_sub(tracked.len()));
        let untracked = self
            .git_limited(&args, r.cancel.as_ref(), remaining)
            .await?
            .stdout;
        Ok(tracked + &untracked)
    }

    async fn remote_git(
        &self,
        operation: RemoteOperation,
        args: &[&str],
        remote: Option<&str>,
        cancel: Option<&CancelToken>,
    ) -> Result<()> {
        self.invalidate_history().await;
        let mut options = self.options();
        options.env = self.ssh_env().await;
        options.cancel = cancel.cloned();
        match run_git_with(args, &options).await {
            Ok(_) => {
                self.auth_blocked.store(false, Ordering::SeqCst);
                Ok(())
            }
            Err(GitError::Command(error)) => {
                let Some(failure) = classify_remote_auth_failure(&error.result.stderr) else {
                    return Err(GitError::Command(error));
                };
                self.auth_blocked.store(true, Ordering::SeqCst);
                Err(GitAuthError {
                    message: describe_remote_auth_failure(operation, &failure, remote),
                    failure,
                    command: Box::new(error),
                }
                .into())
            }
            Err(error) => Err(error),
        }
    }

    /// SSH reads passphrases and host key answers from /dev/tty, which Tuig
    /// owns. GIT_TERMINAL_PROMPT=0 does not stop that. BatchMode=yes makes ssh
    /// fail at once instead. Any SSH command the user configured is left alone.
    async fn ssh_env(&self) -> Vec<(String, Option<String>)> {
        let set = |name: &str| std::env::var_os(name).is_some_and(|v| !v.is_empty());
        if set("GIT_SSH_COMMAND") || set("GIT_SSH") {
            return Vec::new();
        }
        if let Ok(configured) = self.git_read(&["config", "--get", "core.sshCommand"]).await
            && !configured.stdout.trim().is_empty()
        {
            return Vec::new();
        }
        vec![(
            "GIT_SSH_COMMAND".to_string(),
            Some("ssh -o BatchMode=yes".to_string()),
        )]
    }

    async fn apply(&self, args: &[&str], patch: &str) -> Result<()> {
        let mut options = self.options();
        options.stdin = Some(patch.as_bytes().to_vec());
        self.git_with(args, options).await?;
        Ok(())
    }

    /// Recreates `refs/stash` with `stack`, newest entry first.
    async fn rebuild_stashes(&self, stack: &[(String, String)]) -> Result<()> {
        let _ = self
            .git(&["reflog", "expire", "--expire=all", "refs/stash"])
            .await;
        self.git(&["update-ref", "-d", "refs/stash"]).await?;
        for (sha, message) in stack.iter().rev() {
            self.git(&["stash", "store", "-m", message, sha]).await?;
        }
        Ok(())
    }

    async fn rename_stash_inner(&self, reference: &str, message: &str) -> Result<()> {
        let index = reference
            .strip_prefix("stash@{")
            .and_then(|rest| rest.strip_suffix('}'))
            .filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
            .ok_or_else(|| invalid(&format!("Invalid stash reference: {reference}")))?;
        if message.trim().is_empty() || message.contains('\0') {
            return Err(invalid("A stash name is required"));
        }
        let output = self
            .git(&["stash", "list", "--format=%H%x00%gs%x00"])
            .await?
            .stdout;
        let fields: Vec<&str> = output.split('\0').collect();
        let mut entries: Vec<(String, String)> = Vec::new();
        let mut at = 0;
        while at + 1 < fields.len() {
            let sha = fields[at].trim();
            if !sha.is_empty() {
                entries.push((sha.to_string(), fields[at + 1].to_string()));
            }
            at += 2;
        }
        let target = index
            .parse::<usize>()
            .ok()
            .filter(|i| *i < entries.len())
            .ok_or_else(|| refused(format!("Stash not found: {reference}")))?;
        let original = entries[target].0.clone();
        let original_message = entries[target].1.clone();
        let tree = self
            .git(&["rev-parse", "--verify", &format!("{original}^{{tree}}")])
            .await?
            .stdout
            .trim()
            .to_string();
        let parents: Vec<String> = self
            .git(&["rev-list", "--parents", "-n", "1", &original])
            .await?
            .stdout
            .trim()
            .split(' ')
            .skip(1)
            .map(String::from)
            .collect();
        let identity_out = self
            .git(&[
                "show",
                "-s",
                "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI",
                &original,
            ])
            .await?
            .stdout;
        let identity: Vec<&str> = identity_out.split('\0').collect();
        let id = |i: usize| identity.get(i).copied().unwrap_or("");
        let prefix = STASH_PREFIX
            .find(&entries[target].1)
            .map_or("", |m| m.as_str());
        let renamed_message = format!("{prefix}{message}");
        let mut args: Vec<String> = vec!["commit-tree".into(), tree];
        for parent in &parents {
            args.push("-p".into());
            args.push(parent.clone());
        }
        args.push("-m".into());
        args.push(renamed_message.clone());
        let committer_date = id(5).trim();
        entries[target].0 = self
            .git_env(
                &args,
                &[
                    ("GIT_AUTHOR_NAME", id(0)),
                    ("GIT_AUTHOR_EMAIL", id(1)),
                    ("GIT_AUTHOR_DATE", id(2)),
                    ("GIT_COMMITTER_NAME", id(3)),
                    ("GIT_COMMITTER_EMAIL", id(4)),
                    ("GIT_COMMITTER_DATE", committer_date),
                ],
            )
            .await?
            .stdout
            .trim()
            .to_string();
        entries[target].1 = renamed_message;
        let mut originals = entries.clone();
        originals[target] = (original, original_message);
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let backup_prefix = format!("refs/tuig/stash-rename-{}-{millis}", std::process::id());
        for (i, entry) in entries.iter().enumerate() {
            self.git(&["update-ref", &format!("{backup_prefix}/{i}"), &entry.0])
                .await?;
        }
        // Rebuild oldest first because Git provides no reflog-message edit.
        // The temporary refs keep every stash reachable while refs/stash is absent.
        let (result, cleanup) = match self.rebuild_stashes(&entries).await {
            Ok(()) => (Ok(()), true),
            Err(error) => (Err(error), self.rebuild_stashes(&originals).await.is_ok()),
            // When restoration fails, keep the backup refs so no stash is lost.
        };
        if cleanup {
            for i in 0..entries.len() {
                let _ = self
                    .git(&["update-ref", "-d", &format!("{backup_prefix}/{i}")])
                    .await;
            }
        }
        result
    }
}

async fn suggestions(path: &Path, exists: bool) -> Vec<String> {
    nearby_repositories(path, exists)
        .await
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn context_flag(r: &DiffRequest) -> Option<String> {
    r.context.map(|c| format!("-U{c}"))
}

fn diff_paths(r: &DiffRequest) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for path in [
        present(r.original_path.as_deref()),
        present(r.path.as_deref()),
    ]
    .into_iter()
    .flatten()
    {
        if !paths.iter().any(|p| p == path) {
            paths.push(path.to_string());
        }
    }
    paths
}

/// Decodes the C-style path quoting used by blame's porcelain output.
fn parse_git_quoted_path(path: &str) -> String {
    if path.len() < 2 || !path.starts_with('"') || !path.ends_with('"') {
        return path.to_string();
    }
    let inner = &path[1..path.len() - 1];
    let chars: Vec<char> = inner.chars().collect();
    let mut bytes: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        if c != '\\' {
            let mut buffer = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
            continue;
        }
        let Some(&escaped) = chars.get(i) else { break };
        i += 1;
        if ('0'..='7').contains(&escaped) {
            let mut octal = String::from(escaped);
            while octal.len() < 3 && chars.get(i).is_some_and(|d| ('0'..='7').contains(d)) {
                octal.push(chars[i]);
                i += 1;
            }
            // JS pushes the parsed number into a Uint8Array, which wraps at 256.
            bytes.push((u32::from_str_radix(&octal, 8).unwrap_or(0) & 0xff) as u8);
        } else {
            let decoded = match escaped {
                'a' => Some(7),
                'b' => Some(8),
                't' => Some(9),
                'n' => Some(10),
                'v' => Some(11),
                'f' => Some(12),
                'r' => Some(13),
                '"' => Some(34),
                '\\' => Some(92),
                _ => None,
            };
            match decoded {
                Some(byte) => bytes.push(byte),
                None => {
                    let mut buffer = [0u8; 4];
                    bytes.extend_from_slice(escaped.encode_utf8(&mut buffer).as_bytes());
                }
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Opens a repository. Equivalent of the TypeScript `createGitRepository`.
pub async fn create_git_repository(path: impl AsRef<Path>) -> Result<GitRepositoryService> {
    GitRepositoryService::open(path).await
}

#[async_trait]
impl GitRepository for GitRepositoryService {
    async fn dispose(&self) {
        self.walk.invalidate().await;
    }

    fn root(&self) -> &str {
        &self.root
    }

    fn main_worktree(&self) -> Option<&str> {
        self.main_worktree.as_deref()
    }

    async fn remote_url(&self) -> Option<String> {
        let url = self.git(&["remote", "get-url", "origin"]).await.ok()?;
        let url = url.stdout.trim();
        (!url.is_empty()).then(|| url.to_string())
    }

    fn auth_blocked(&self) -> bool {
        self.auth_blocked.load(Ordering::SeqCst)
    }

    async fn watch_paths(&self) -> Result<Option<RepositoryWatchPaths>> {
        let dirs = self
            .git(&[
                "rev-parse",
                "--path-format=absolute",
                "--git-dir",
                "--git-common-dir",
            ])
            .await?;
        let text = dirs.stdout.trim();
        let mut lines = text.split('\n');
        let git_dir = lines.next().unwrap_or("");
        let common_dir = lines.next().unwrap_or("");
        // Watch events name real paths, so symlinks are resolved up front.
        let real = |path: &str| -> Result<String> {
            Ok(std::fs::canonicalize(PathBuf::from(path))?
                .to_string_lossy()
                .into_owned())
        };
        Ok(Some(RepositoryWatchPaths {
            work_tree: real(&self.root)?,
            git_dir: real(git_dir)?,
            common_dir: real(common_dir)?,
        }))
    }

    async fn snapshot(&self, limit: usize) -> Result<RepositorySnapshot> {
        self.load_snapshot(limit, None).await
    }

    async fn snapshot_early(
        &self,
        limit: usize,
        early: EarlyHistory,
    ) -> Result<RepositorySnapshot> {
        self.load_snapshot(limit, Some(early)).await
    }

    async fn refresh_snapshot(
        &self,
        previous: &RepositorySnapshot,
        limit: usize,
    ) -> Result<RepositorySnapshot> {
        let metadata = self.read_snapshot_metadata().await?;
        let prior = self.signatures().get(&tip_key(&previous.commits)).cloned();
        if prior.as_ref() == Some(&metadata.history_signature)
            && (previous.commits_complete || previous.commits.len() >= limit)
        {
            let signature = metadata.history_signature.clone();
            let snapshot = self.build_snapshot(
                metadata,
                previous.commits.clone(),
                previous.commits_complete,
            );
            self.remember_signature(&snapshot.commits, signature);
            return Ok(snapshot);
        }
        self.invalidate_history().await;
        let log = self.commit_page(limit, 0).await?;
        let signature = metadata.history_signature.clone();
        let snapshot = self.build_snapshot(metadata, log.commits, log.complete);
        self.remember_signature(&snapshot.commits, signature);
        Ok(snapshot)
    }

    /// Reads `limit` commits across every ref, starting `skip` commits in.
    ///
    /// One extra commit is requested so the caller learns whether older history
    /// remains without a second walk; it is dropped before returning. The page
    /// is served from a `CommitWalk` held open across calls, so reading pages
    /// in sequence costs only the commits each page emits. A `skip` the open
    /// walk cannot reach restarts it with `--skip`.
    async fn commit_page(&self, limit: usize, skip: usize) -> Result<CommitPage> {
        let wanted = limit.max(1);
        let offset = skip;
        // Git's default walk is already newest-first by commit date.
        // `--date-order` only adds the guarantee that no parent is emitted
        // before its children, and buying it costs a walk of the entire
        // history. The graph layout opens a fresh lane for a commit it has not
        // seen yet, so a clock-skewed parent degrades to an extra lane.
        //
        // The walk excludes refs/stash, so each stash tip is layered back here
        // as a single row. A stash can outlive newer commits, so merge tips by
        // commit time instead of always putting them at the top.
        let tips = self.stash_tip_commits().await;
        // At most every tip can occur before this page, so this is the earliest
        // ordinary commit that could occupy `offset`. Including all tips then
        // gives the merged window a known global starting position.
        let walk_offset = offset.saturating_sub(tips.len());
        let local_offset = offset - walk_offset;
        let walked = self.walk.read(walk_offset, wanted + tips.len() + 1).await?;
        Ok(merge_page(tips, walked, wanted, local_offset))
    }

    /// Re-reads only the working tree and branch tracking state.
    ///
    /// Staging a file cannot change history, so the index mutations refresh
    /// through this instead of paying for the full snapshot's history walk.
    async fn working_status(&self) -> Result<WorkingStatus> {
        let (status, worktrees) = tokio::join!(
            self.git(&[
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "--untracked-files=all",
                "--branch",
                "-z",
            ]),
            self.git(&["worktree", "list", "--porcelain"]),
        );
        let status = status?.stdout;
        let worktrees = worktrees?.stdout;
        let tracking = parse_tracking(&status);
        Ok(WorkingStatus {
            upstream: tracking.upstream,
            ahead: tracking.ahead,
            behind: tracking.behind,
            files: without_linked_worktrees(
                parse_status(&status),
                &parse_worktrees(&worktrees),
                &self.root,
            ),
        })
    }

    /// Reads the history of one path on the current branch or from `start`.
    async fn file_history(&self, path: &str, start: Option<&str>) -> Result<Vec<Commit>> {
        Self::validate_history_path(path)?;
        if let Some(start) = start {
            Self::validate_commit_ref(start)?;
        }
        let mut args = vec!["log", "--follow", "--decorate", "-z", LOG_FORMAT];
        if let Some(start) = start {
            args.extend(["--end-of-options", start]);
        }
        args.extend(["--", path]);
        Ok(parse_log(&self.git(&args).await?.stdout))
    }

    /// Reads commits that changed the ancestry of one line.
    async fn line_history(
        &self,
        path: &str,
        line: usize,
        start: Option<&str>,
    ) -> Result<Vec<Commit>> {
        let start = start.unwrap_or("HEAD");
        Self::validate_history_path(path)?;
        Self::validate_line(line)?;
        Self::validate_commit_ref(start)?;
        let result = self
            .git(&[
                "log",
                "--decorate",
                "-z",
                LOG_FORMAT,
                &format!("-L{line},{line}:{path}"),
                start,
            ])
            .await?;
        // -L necessarily emits patches between formatted records. Keep only the
        // machine-formatted commit portions before passing them to the log parser.
        let mut records = String::new();
        for chunk in result.stdout.split('\x1e') {
            let bytes = chunk.as_bytes();
            let mut field = chunk.find('\x1f');
            while let Some(at) = field.filter(|at| *at >= 40) {
                let mut begin = at;
                while begin > 0 && matches!(bytes[begin - 1], b'0'..=b'9' | b'a'..=b'f') {
                    begin -= 1;
                }
                if at - begin >= 40 {
                    records.push_str(&chunk[begin..]);
                    records.push('\x1e');
                    break;
                }
                field = chunk[at + 1..].find('\x1f').map(|next| next + at + 1);
            }
        }
        Ok(parse_log(&records))
    }

    /// Blames one line at a commit, defaulting to HEAD.
    async fn blame_line(&self, path: &str, line: usize, commit: Option<&str>) -> Result<LineBlame> {
        let commit = commit.unwrap_or("HEAD");
        Self::validate_history_path(path)?;
        Self::validate_line(line)?;
        Self::validate_commit_ref(commit)?;
        // Unlike log/show, blame does not accept --end-of-options. Validating
        // the ref keeps it from becoming an option, and -- disambiguates the path.
        let blame = self
            .git(&[
                "blame",
                "--line-porcelain",
                &format!("-L{line},{line}"),
                commit,
                "--",
                path,
            ])
            .await?;
        let Some(header) = BLAME_HEADER.captures(&blame.stdout) else {
            return Err(refused(format!(
                "Git returned no blame information for {path}:{line}"
            )));
        };
        let sha = header[1].to_string();
        let original_line: usize = header[2].parse().unwrap_or(0);
        let final_line: usize = header[3].parse().unwrap_or(0);
        let filename = blame
            .stdout
            .split('\n')
            .find_map(|entry| entry.strip_prefix("filename "));
        let details = self
            .git(&[
                "show",
                "-s",
                "--decorate",
                "-z",
                LOG_FORMAT,
                "--end-of-options",
                &format!("{sha}^{{commit}}"),
            ])
            .await?;
        let Some(blamed) = parse_log(&details.stdout).into_iter().next() else {
            return Err(refused(format!(
                "Git returned no commit information for {sha}"
            )));
        };
        Ok(LineBlame {
            commit: blamed,
            original_path: match filename {
                Some(name) if !name.is_empty() => parse_git_quoted_path(name),
                _ => path.to_string(),
            },
            original_line,
            final_path: path.to_string(),
            final_line,
        })
    }

    async fn diff(&self, r: &DiffRequest) -> Result<String> {
        if present(r.base.as_deref()).is_some() || present(r.target.as_deref()).is_some() {
            return self.comparison_diff(r).await;
        }
        if let Some(commit) = present(r.commit.as_deref()) {
            return self.commit_diff(r, commit).await;
        }
        let path = present(r.path.as_deref());
        let mut args: Vec<String> = vec!["diff".into(), "--no-ext-diff".into()];
        if r.staged {
            args.push("--cached".into());
        }
        args.extend(context_flag(r));
        args.push("--".into());
        args.extend(path.map(String::from));
        let result = self
            .git_limited(&args, r.cancel.as_ref(), r.max_bytes)
            .await?;
        let Some(path) = path else {
            return Ok(result.stdout);
        };
        if !result.stdout.is_empty() || r.staged {
            return Ok(result.stdout);
        }
        if self
            .git_limited(
                &["ls-files", "--error-unmatch", "--", path],
                r.cancel.as_ref(),
                None,
            )
            .await
            .is_ok()
        {
            return Ok(String::new());
        }
        let mut args: Vec<String> =
            vec!["diff".into(), "--no-index".into(), "--no-ext-diff".into()];
        args.extend(context_flag(r));
        args.extend(["--", "/dev/null", path].map(String::from));
        match self
            .git_limited(&args, r.cancel.as_ref(), r.max_bytes)
            .await
        {
            Err(GitError::Command(error)) if error.result.exit_code == 1 => Ok(error.result.stdout),
            Err(error) => Err(error),
            Ok(_) => Ok(String::new()),
        }
    }

    async fn commit_files(&self, sha: &str, base: Option<&str>) -> Result<Vec<ChangedFile>> {
        if let Some(base) = present(base) {
            Self::validate_commit_ref(base)?;
            Self::validate_commit_ref(sha)?;
            let out = self
                .git(&[
                    "diff",
                    "--name-status",
                    "-z",
                    "-M",
                    "--end-of-options",
                    base,
                    sha,
                ])
                .await?;
            return Ok(parse_name_status(&out.stdout));
        }
        let (resolved, parents, untracked_parent) = self.commit_details(sha, None).await?;
        let mut args = vec![
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-status",
            "-z",
            "-r",
            "-M",
        ];
        match parents.first() {
            Some(parent) => args.extend([parent.as_str(), resolved.as_str()]),
            None => args.push(&resolved),
        }
        let mut files = parse_name_status(&self.git(&args).await?.stdout);
        if let Some(untracked) = untracked_parent {
            let mut args = vec![
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-z",
                "-r",
                "-M",
            ];
            args.push(&untracked);
            files.extend(parse_name_status(&self.git(&args).await?.stdout));
        }
        let mut seen: Vec<String> = Vec::new();
        files.retain(|file| {
            if seen.contains(&file.path) {
                false
            } else {
                seen.push(file.path.clone());
                true
            }
        });
        Ok(files)
    }

    async fn stage(&self, paths: &[String]) -> Result<()> {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.git(&args).await?;
        Ok(())
    }

    async fn unstage(&self, paths: &[String]) -> Result<()> {
        let mut args = vec!["reset", "HEAD", "--"];
        args.extend(paths.iter().map(String::as_str));
        self.git(&args).await?;
        Ok(())
    }

    async fn apply_patch(&self, patch: &str, reverse: bool) -> Result<()> {
        let mut args = vec!["apply", "--cached"];
        if reverse {
            args.push("--reverse");
        }
        self.apply(&args, patch).await
    }

    async fn discard_patch(&self, patch: &str) -> Result<()> {
        self.apply(&["apply", "--reverse"], patch).await
    }

    async fn discard_all(&self) -> Result<()> {
        // discard restores tracked files and removes untracked content.
        self.discard(&[".".to_string()]).await
    }

    async fn discard(&self, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let literal: Vec<String> = paths
            .iter()
            .map(|path| {
                if path == "." {
                    ":(top)".to_string()
                } else {
                    format!(":(top,literal){path}")
                }
            })
            .collect();
        // Restore only paths known to the index. Passing an untracked path to
        // restore makes the whole command fail before the path can be cleaned.
        let mut args: Vec<&str> = vec!["ls-files", "-z", "--"];
        args.extend(literal.iter().map(String::as_str));
        let listing = self.git(&args).await?.stdout;
        let tracked: Vec<String> = listing
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(|p| format!(":(top,literal){p}"))
            .collect();
        if !tracked.is_empty() {
            let mut args: Vec<&str> = vec!["restore", "--worktree", "--"];
            args.extend(tracked.iter().map(String::as_str));
            self.git(&args).await?;
        }
        // clean ignores tracked files. Restrict it to the requested pathspecs
        // and deliberately omit -x so ignored content is never deleted.
        let mut args: Vec<&str> = vec!["clean", "-fd", "--"];
        args.extend(literal.iter().map(String::as_str));
        self.git(&args).await?;
        Ok(())
    }

    async fn commit(&self, message: &str) -> Result<()> {
        self.git(&["commit", "-m", message]).await?;
        Ok(())
    }

    async fn amend_commit(&self, message: &str) -> Result<()> {
        self.git(&["commit", "--amend", "-m", message]).await?;
        Ok(())
    }

    async fn reword_commit(&self, sha: &str, message: &str) -> Result<()> {
        let status = self.git(&["status", "--porcelain"]).await?;
        if !status.stdout.is_empty() {
            return Err(refused("Cannot reword a commit with a dirty worktree"));
        }
        if self
            .git(&["symbolic-ref", "--quiet", "HEAD"])
            .await
            .is_err()
        {
            return Err(refused("Cannot reword a commit while HEAD is detached"));
        }
        let target = self
            .git(&["rev-parse", "--verify", &format!("{sha}^{{commit}}")])
            .await?
            .stdout
            .trim()
            .to_string();
        if self
            .git(&["merge-base", "--is-ancestor", &target, "HEAD"])
            .await
            .is_err()
        {
            return Err(refused(
                "Can only reword commits reachable from the current HEAD",
            ));
        }
        let parents = self
            .git(&["show", "-s", "--format=%P", &target])
            .await?
            .stdout
            .trim()
            .to_string();
        self.invalidate_history().await;
        let helpers = RewordHelpers::create(message, &target)?;
        let mut options = self.options();
        options.env = vec![
            (
                "GIT_SEQUENCE_EDITOR".into(),
                Some(helpers.sequence_editor.to_string_lossy().into_owned()),
            ),
            (
                "GIT_EDITOR".into(),
                Some(helpers.editor.to_string_lossy().into_owned()),
            ),
        ];
        let onto = parents.split(' ').next().unwrap_or("").to_string();
        let parent_ref = format!("{target}^");
        let args: Vec<&str> = if parents.is_empty() {
            vec!["rebase", "-i", "--rebase-merges", "--root"]
        } else {
            vec![
                "rebase",
                "-i",
                "--rebase-merges",
                "--onto",
                &onto,
                &parent_ref,
            ]
        };
        let result = run_git_with(&args, &options).await;
        if result.is_err() {
            // A failed interactive rebase leaves repository state behind unless
            // it is explicitly aborted. Keep the original error, which explains
            // why the requested reword failed, rather than the abort cleanup's.
            let _ = self.git(&["rebase", "--abort"]).await;
        }
        drop(helpers);
        result.map(|_| ())
    }

    async fn switch_branch(&self, name: &str) -> Result<()> {
        self.git(&["switch", name]).await?;
        self.sync_submodules().await
    }

    async fn checkout_commit(&self, sha: &str) -> Result<()> {
        self.git(&["checkout", "--detach", sha]).await?;
        self.sync_submodules().await
    }

    async fn checkout_remote_branch(&self, local: &str, remote: &str, reset: bool) -> Result<()> {
        // `-C` moves an existing local branch onto the remote tip, discarding
        // the local commits that are not on the remote.
        self.git(&[
            "switch",
            if reset { "-C" } else { "-c" },
            local,
            "--track",
            remote,
        ])
        .await?;
        self.sync_submodules().await
    }

    async fn get_undo_preview(&self) -> Result<UndoPreview> {
        undo::get_undo_preview(self).await
    }

    async fn undo(&self, preview: &UndoPreview) -> Result<()> {
        undo::undo(self, preview).await
    }

    async fn reset_to(&self, sha: &str, mode: ResetMode) -> Result<()> {
        self.git(&["reset", mode.flag(), sha]).await?;
        if mode == ResetMode::Hard {
            self.sync_submodules().await?;
        }
        Ok(())
    }

    async fn rebase_onto(&self, reference: &str) -> Result<()> {
        self.git(&["rebase", reference]).await?;
        Ok(())
    }

    async fn cherry_pick(&self, sha: &str) -> Result<()> {
        if sha.trim().is_empty() || sha.contains('\0') {
            return Err(invalid("A commit is required for cherry-pick"));
        }
        // Keep a ref supplied by a caller from being interpreted as a
        // cherry-pick option (for example, `--abort`).
        self.git(&["cherry-pick", "--", sha]).await?;
        Ok(())
    }

    /// Creates a lightweight tag; annotated tags are deliberately not implied.
    async fn create_tag(&self, name: &str, target: Option<&str>) -> Result<()> {
        if name.trim().is_empty() || name.contains('\0') {
            return Err(invalid("A tag name is required"));
        }
        if let Some(target) = target
            && (target.trim().is_empty() || target.contains('\0'))
        {
            return Err(invalid("A tag target is required"));
        }
        // Let Git validate the complete ref name so names containing `..`, a
        // trailing dot, or other invalid ref syntax are rejected before creation.
        self.git(&[
            "check-ref-format",
            "--allow-onelevel",
            &format!("refs/tags/{name}"),
        ])
        .await?;
        // `--` also makes otherwise valid names beginning with `-` safe.
        let mut args = vec!["tag", "--", name];
        args.extend(target);
        self.git(&args).await?;
        Ok(())
    }

    async fn push_tag(
        &self,
        name: &str,
        remote: Option<&str>,
        cancel: Option<&CancelToken>,
    ) -> Result<()> {
        self.validate_tag_name(name).await?;
        let reference = format!("refs/tags/{name}");
        let remote = present(remote);
        let mut args = vec!["push"];
        args.extend(remote);
        args.extend(["--", &reference]);
        self.remote_git(RemoteOperation::Push, &args, remote, cancel)
            .await
    }

    async fn delete_tag(&self, name: &str) -> Result<()> {
        self.validate_tag_name(name).await?;
        self.git(&["tag", "--delete", "--", name]).await?;
        Ok(())
    }

    async fn create_branch(
        &self,
        name: &str,
        start_point: Option<&str>,
        checkout: bool,
    ) -> Result<()> {
        let mut args = vec!["branch"];
        if checkout {
            args.push("--create-reflog");
        }
        args.push(name);
        args.extend(present(start_point));
        self.git(&args).await?;
        if checkout {
            self.switch_branch(name).await?;
        }
        Ok(())
    }

    async fn delete_branch(&self, name: &str, force: bool, remote: bool) -> Result<()> {
        let mut args = vec!["branch"];
        if remote {
            args.push("-r");
        }
        args.push(if force { "-D" } else { "-d" });
        args.push(name);
        self.git(&args).await?;
        Ok(())
    }

    async fn delete_remote_branch(&self, name: &str, cancel: Option<&CancelToken>) -> Result<()> {
        let listing = self.git(&["remote"]).await?.stdout;
        let remote = listing
            .trim()
            .split('\n')
            .filter(|candidate| {
                !candidate.is_empty()
                    && name
                        .strip_prefix(candidate)
                        .is_some_and(|rest| rest.starts_with('/'))
            })
            .max_by_key(|candidate| candidate.len())
            .ok_or_else(|| refused(format!("No configured remote for {name}")))?;
        let branch = &name[remote.len() + 1..];
        self.git(&["check-ref-format", &format!("refs/heads/{branch}")])
            .await?;
        self.remote_git(
            RemoteOperation::Push,
            &[
                "push",
                "--delete",
                "--",
                remote,
                &format!("refs/heads/{branch}"),
            ],
            Some(remote),
            cancel,
        )
        .await
    }

    async fn fetch(&self, remote: Option<&str>, cancel: Option<&CancelToken>) -> Result<()> {
        // Remove remote-tracking refs that disappeared from the remote. Without
        // pruning, the sidebar and graph keep showing branches deleted upstream.
        let remote = present(remote);
        let mut args = vec!["fetch", "--prune"];
        args.extend(remote);
        self.remote_git(RemoteOperation::Fetch, &args, remote, cancel)
            .await
    }

    async fn pull(&self, rebase: bool, cancel: Option<&CancelToken>) -> Result<()> {
        let mut args = vec!["pull"];
        if rebase {
            args.push("--rebase");
        }
        self.remote_git(RemoteOperation::Pull, &args, None, cancel)
            .await
    }

    async fn push(
        &self,
        remote: Option<&str>,
        set_upstream: bool,
        cancel: Option<&CancelToken>,
    ) -> Result<()> {
        let remote = present(remote);
        let mut args = vec!["push"];
        if set_upstream {
            args.push("-u");
        }
        args.extend(remote);
        self.remote_git(RemoteOperation::Push, &args, remote, cancel)
            .await
    }

    async fn stash(&self, message: Option<&str>, include_untracked: bool) -> Result<()> {
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if let Some(message) = present(message) {
            args.extend(["-m", message]);
        }
        self.git(&args).await?;
        Ok(())
    }

    async fn apply_stash(&self, reference: &str, pop: bool) -> Result<()> {
        self.git(&["stash", if pop { "pop" } else { "apply" }, reference])
            .await?;
        Ok(())
    }

    async fn pop_stash(&self, reference: &str) -> Result<()> {
        self.apply_stash(reference, true).await
    }

    async fn drop_stash(&self, reference: &str) -> Result<()> {
        self.git(&["stash", "drop", reference]).await?;
        Ok(())
    }

    async fn rename_stash(&self, reference: &str, message: &str) -> Result<()> {
        self.rename_stash_inner(reference, message).await
    }

    async fn update_submodule(&self, path: &str, init: bool) -> Result<()> {
        Self::validate_submodule_path(path)?;
        let mut args = vec!["submodule", "update"];
        if init {
            args.push("--init");
        }
        args.extend(["--recursive", "--", path]);
        self.git(&args).await?;
        Ok(())
    }

    async fn sync_submodule(&self, path: &str) -> Result<()> {
        Self::validate_submodule_path(path)?;
        self.git(&["submodule", "sync", "--recursive", "--", path])
            .await?;
        Ok(())
    }

    async fn add_worktree(
        &self,
        path: &str,
        branch: Option<&str>,
        create_branch: bool,
    ) -> Result<()> {
        let branch = present(branch);
        let mut args = vec!["worktree", "add"];
        if let (true, Some(branch)) = (create_branch, branch) {
            args.extend(["-b", branch]);
        }
        args.push(path);
        if let (false, Some(branch)) = (create_branch, branch) {
            args.push(branch);
        }
        self.git(&args).await?;
        Ok(())
    }

    async fn remove_worktree(&self, path: &str, force: bool) -> Result<()> {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(path);
        self.git(&args).await?;
        Ok(())
    }

    async fn lock_worktree(&self, path: &str, lock: bool, reason: Option<&str>) -> Result<()> {
        let mut args = vec!["worktree", if lock { "lock" } else { "unlock" }];
        if let (true, Some(reason)) = (lock, present(reason)) {
            args.extend(["--reason", reason]);
        }
        args.push(path);
        self.git(&args).await?;
        Ok(())
    }
}

/// Scripts and message file for a reword rebase, in a private temporary
/// directory that is removed when this value drops.
struct RewordHelpers {
    dir: PathBuf,
    sequence_editor: PathBuf,
    editor: PathBuf,
}

impl RewordHelpers {
    fn create(message: &str, target: &str) -> Result<Self> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let base = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let mut attempt = 0u32;
        let dir = loop {
            let candidate = base.join(format!(
                "tuig-reword-{}-{nanos}-{attempt}",
                std::process::id()
            ));
            match std::fs::DirBuilder::new().mode(0o700).create(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == ErrorKind::AlreadyExists && attempt < 100 => {
                    attempt += 1;
                }
                Err(error) => return Err(error.into()),
            }
        };
        // Removes the directory if a later step fails.
        let helpers = Self {
            sequence_editor: dir.join("sequence-editor"),
            editor: dir.join("editor"),
            dir,
        };
        let message_path = helpers.dir.join("message");
        std::fs::write(&message_path, message)?;
        // Rebase abbreviates object IDs in its todo file, so match its stable
        // seven-character prefix rather than requiring the full SHA.
        let prefix: String = target.chars().take(7).collect();
        std::fs::write(
            &helpers.sequence_editor,
            format!(
                "#!/bin/sh\nsed -i -e '0,/^pick {prefix}/s//reword {prefix}/' -e '0,/^merge -C {prefix}/s//merge -c {prefix}/' \"$1\"\n"
            ),
        )?;
        std::fs::write(
            &helpers.editor,
            format!("#!/bin/sh\ncat \"{}\" > \"$1\"\n", message_path.display()),
        )?;
        for script in [&helpers.sequence_editor, &helpers.editor] {
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(helpers)
    }
}

impl Drop for RewordHelpers {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests;

/// Merges stash tip rows into walked commits by commit time and cuts one page.
fn merge_page(
    tips: Vec<Commit>,
    walked: Vec<Commit>,
    wanted: usize,
    local_offset: usize,
) -> CommitPage {
    let mut merged: Vec<Commit> = tips.into_iter().chain(walked).collect();
    merged.sort_by_key(|c| std::cmp::Reverse(parse_instant(&c.committed_at).unwrap_or(i64::MIN)));
    let mut page: Vec<Commit> = merged
        .into_iter()
        .skip(local_offset)
        .take(wanted + 1)
        .collect();
    let complete = page.len() <= wanted;
    if !complete {
        page.truncate(wanted);
    }
    CommitPage {
        commits: page,
        complete,
    }
}
