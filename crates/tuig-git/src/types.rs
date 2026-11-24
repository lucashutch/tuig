//! Domain types shared by the parsers, the process runner, and the repository
//! service. Port of `src/git/types.ts`.
//!
//! The TypeScript `GitRepository` interface is not ported here. It describes
//! the async repository service and belongs to `repository.rs`.

use crate::process::CancelToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileState {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: String,
    pub original_path: Option<String>,
    pub state: FileState,
    pub staged: bool,
    pub unstaged: bool,
    pub submodule: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BranchRef {
    pub name: String,
    pub full_name: String,
    pub sha: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
    pub tracking: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub authored_at: String,
    pub committer: String,
    pub committer_email: String,
    pub committed_at: String,
    pub subject: String,
    pub body: Option<String>,
    pub decorations: Vec<String>,
}

/// The commit and source location responsible for one line in a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineBlame {
    pub commit: Commit,
    /// Path and line in the blamed commit, before later edits or renames.
    pub original_path: String,
    pub original_line: usize,
    /// Path and line at the requested commit.
    pub final_path: String,
    pub final_line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

impl ResetMode {
    /// The `git reset` flag, for example `--soft`.
    pub fn flag(self) -> &'static str {
        match self {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stash {
    pub reference: String,
    pub sha: String,
    pub created_at: String,
    pub subject: String,
    /// Branch the stash was created on, parsed from its subject when present.
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: String,
    pub sha: String,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    /// `Some("")` means locked without a reason.
    pub locked: Option<String>,
    /// `Some("")` means prunable without a reason.
    pub prunable: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmoduleState {
    Clean,
    Uninitialized,
    Different,
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submodule {
    /// The submodule's name from .gitmodules, when configured.
    pub name: Option<String>,
    pub path: String,
    pub sha: String,
    pub state: SubmoduleState,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RepositorySnapshot {
    pub root: String,
    /// Commit currently checked out, including detached HEAD.
    pub head_sha: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<ChangedFile>,
    pub branches: Vec<BranchRef>,
    pub stashes: Vec<Stash>,
    pub worktrees: Vec<Worktree>,
    pub submodules: Vec<Submodule>,
    pub commits: Vec<Commit>,
    /// False while older commits remain unread beyond the requested page.
    pub commits_complete: bool,
}

/// One page of history, with whether it reached the end of the graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitPage {
    pub commits: Vec<Commit>,
    pub complete: bool,
}

/// The subset of a snapshot that an index or working-tree change can alter.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkingStatus {
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<ChangedFile>,
}

/// Real directories a repository's state lives in. A linked worktree or a
/// submodule has a `.git` file, so its Git dir is outside the work tree, and a
/// linked worktree keeps branch refs in the shared common dir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryWatchPaths {
    pub work_tree: String,
    /// Holds HEAD and the index.
    pub git_dir: String,
    /// Holds refs and packed-refs.
    pub common_dir: String,
}

#[derive(Debug, Clone, Default)]
pub struct DiffRequest {
    pub path: Option<String>,
    /// Previous path when the selected entry is a rename or copy.
    pub original_path: Option<String>,
    pub staged: bool,
    pub commit: Option<String>,
    /// Older endpoint for a direct two-commit comparison. Requires `target`.
    pub base: Option<String>,
    /// Newer endpoint for a direct two-commit comparison. Requires `base`.
    pub target: Option<String>,
    pub context: Option<u32>,
    pub cancel: Option<CancelToken>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoPreview {
    pub head: String,
    pub target: String,
    pub branch: String,
    pub action: String,
    pub reflog_token: String,
}
