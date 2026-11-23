//! Runs Git subprocesses, tracks Tuig's own processes, and defines Git error
//! types. Port of `src/git/process.ts`.
//!
//! Differences from the TypeScript version:
//! - The runner is async on tokio. Independent calls run together with
//!   `tokio::join!`.
//! - `AbortSignal` becomes [`CancelToken`], a wrapper around a tokio
//!   `CancellationToken`. Cancelling wakes the runner at once.
//! - Dropping the future of a run kills the Git process. When the run has a
//!   cancel token or output limit, Git runs in its own process group and the
//!   whole group is killed.
//! - `RunOptions::stdin` is new. `git apply` needs patch input on stdin.
//! - Output is decoded like `TextDecoder`: invalid UTF-8 becomes U+FFFD and a
//!   leading byte order mark is dropped.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::remote_errors::RemoteAuthFailure;
use crate::types::CommandResult;

/// Signal a caller sets to cancel a running command. Clones share state.
///
/// A thin wrapper over a tokio `CancellationToken`: `await` [`Self::cancelled`]
/// in a `select!` instead of polling [`Self::is_cancelled`].
#[derive(Debug, Clone, Default)]
pub struct CancelToken(CancellationToken);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.is_cancelled()
    }

    /// Completes once the token is cancelled.
    pub async fn cancelled(&self) {
        self.0.cancelled().await;
    }
}

fn join_args<S: AsRef<str>>(args: &[S]) -> String {
    args.iter().map(AsRef::as_ref).collect::<Vec<_>>().join(" ")
}

/// A fetch, pull, or push failed because credentials or a host key are missing.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct GitAuthError {
    pub message: String,
    pub failure: RemoteAuthFailure,
    pub command: Box<GitCommandError>,
}

/// Git exited with a nonzero code.
#[derive(Debug, Clone, thiserror::Error)]
#[error("git {}: {}", .args.join(" "), command_detail(.result))]
pub struct GitCommandError {
    pub args: Vec<String>,
    pub result: CommandResult,
}

fn command_detail(result: &CommandResult) -> String {
    let stderr = result.stderr.trim();
    if stderr.is_empty() {
        format!("exit {}", result.exit_code)
    } else {
        stderr.to_string()
    }
}

impl GitCommandError {
    pub fn new<S: AsRef<str>>(args: &[S], result: CommandResult) -> Self {
        Self {
            args: args.iter().map(|a| a.as_ref().to_string()).collect(),
            result,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NotRepositoryProblem {
    #[default]
    NotRepository,
    Missing,
    NotDirectory,
}

/// Raised when the path used to launch Tuig is outside a Git work tree.
#[derive(Debug, Clone)]
pub struct NotGitRepositoryError {
    pub path: String,
    pub suggestions: Vec<String>,
    pub problem: NotRepositoryProblem,
    message: String,
}

impl NotGitRepositoryError {
    pub fn new(path: &str, suggestions: Vec<String>, problem: NotRepositoryProblem) -> Self {
        let description = match problem {
            NotRepositoryProblem::Missing => format!("Path \"{path}\" does not exist."),
            NotRepositoryProblem::NotDirectory => format!("Path \"{path}\" is not a directory."),
            NotRepositoryProblem::NotRepository => {
                format!("No Git repository found at \"{path}\".")
            }
        };
        let hint = if suggestions.is_empty() {
            "\n\nHint: Run tuig from inside a Git repository or pass the path to one.".to_string()
        } else {
            let lines: Vec<String> = suggestions
                .iter()
                .map(|candidate| format!("  tuig {}", shell_path(candidate)))
                .collect();
            format!("\n\nRepositories found nearby:\n{}", lines.join("\n"))
        };
        Self {
            path: path.to_string(),
            suggestions,
            problem,
            message: description + &hint,
        }
    }
}

impl fmt::Display for NotGitRepositoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NotGitRepositoryError {}

fn shell_path(path: &str) -> String {
    let plain = !path.is_empty()
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./:@%+=,-".contains(c));
    if plain {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', "'\"'\"'"))
    }
}

async fn repository_directories(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        // Like a Node `Dirent`, a symlink to a directory is not a directory here.
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let candidate = entry.path();
        if !candidate.join(".git").exists() {
            continue;
        }
        let options = RunOptions::in_dir(&candidate);
        let Ok(result) = run_git_with(&["rev-parse", "--show-toplevel"], &options).await else {
            continue;
        };
        let root = result.stdout.trim().to_string();
        let same = std::path::absolute(&root).ok() == std::path::absolute(&candidate).ok();
        if same {
            found.push(candidate);
        }
    }
    found
}

fn edit_distance(left: &str, right: &str) -> usize {
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for i in 1..=left.len() {
        let mut current = vec![i];
        for j in 1..=right.len() {
            let substitution = previous[j - 1] + usize::from(left[i - 1] != right[j - 1]);
            current.push((current[j - 1] + 1).min(previous[j] + 1).min(substitution));
        }
        previous = current;
    }
    previous[right.len()]
}

fn base_name_lower(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// Up to three repositories near `path`. When `path` exists, its child
/// repositories sorted by name. Otherwise sibling repositories with a similar name.
///
/// Sorting uses byte order where the TypeScript code uses `localeCompare`.
pub async fn nearby_repositories(path: &Path, path_exists: bool) -> Vec<PathBuf> {
    if path_exists {
        let mut found = repository_directories(path).await;
        found.sort();
        found.truncate(3);
        return found;
    }
    let wanted = base_name_lower(path);
    let wanted_len = wanted.encode_utf16().count();
    let threshold = 2.max(wanted_len * 2 / 5);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut scored: Vec<(usize, PathBuf)> = repository_directories(parent)
        .await
        .into_iter()
        .map(|candidate| {
            (
                edit_distance(&wanted, &base_name_lower(&candidate)),
                candidate,
            )
        })
        .filter(|(distance, _)| *distance <= threshold)
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(3).map(|(_, c)| c).collect()
}

/// Raised when a caller cancelled a running Git command.
#[derive(Debug, Clone, thiserror::Error)]
#[error("git {}: cancelled", .args.join(" "))]
pub struct GitCommandAbortedError {
    pub args: Vec<String>,
}

/// Raised when a command emits more stdout than its caller permits.
#[derive(Debug, Clone, thiserror::Error)]
#[error("git {}: output exceeded {limit_bytes} bytes", .args.join(" "))]
pub struct GitOutputLimitError {
    pub args: Vec<String>,
    pub limit_bytes: usize,
}

/// Every failure a Git call can report.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error(transparent)]
    Command(#[from] GitCommandError),
    #[error(transparent)]
    Auth(#[from] GitAuthError),
    #[error(transparent)]
    NotRepository(#[from] NotGitRepositoryError),
    #[error(transparent)]
    Aborted(#[from] GitCommandAbortedError),
    #[error(transparent)]
    OutputLimit(#[from] GitOutputLimitError),
    /// Git could not start, for example because it is not installed.
    #[error("git {}: {source}", join_args(.args))]
    Spawn {
        args: Vec<String>,
        source: std::io::Error,
    },
    /// A rejected argument, such as an empty file path. The TypeScript `Error` or `RangeError` of an argument check.
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The TUI cannot answer prompts printed to its terminal, so credential
/// requests are disabled outright: Git fails fast with a clear error instead
/// of blocking the whole interface on an invisible prompt.
pub const NON_INTERACTIVE_ENV: [(&str, &str); 2] =
    [("GIT_TERMINAL_PROMPT", "0"), ("GIT_ASKPASS", "")];

static OWN_GIT_PROCESSES: AtomicUsize = AtomicUsize::new(0);
static OWN_GIT_EXITED_AT: Mutex<Option<Instant>> = Mutex::new(None);

/// Counts one Git process until it is dropped. See [`track_own_git_process`].
#[derive(Debug)]
#[must_use = "the process counts as running until this guard is dropped"]
pub struct OwnGitGuard(());

impl Drop for OwnGitGuard {
    fn drop(&mut self) {
        OWN_GIT_PROCESSES.fetch_sub(1, Ordering::SeqCst);
        *OWN_GIT_EXITED_AT
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
    }
}

/// Count a Git process Tuig started, until the returned guard drops.
///
/// Read-only commands such as `git diff` still rewrite `.git/index` to cache
/// file stat data, even with `--no-optional-locks`. The repository watcher
/// uses this count to tell those writes apart from changes made in another
/// terminal.
pub fn track_own_git_process() -> OwnGitGuard {
    OWN_GIT_PROCESSES.fetch_add(1, Ordering::SeqCst);
    OwnGitGuard(())
}

/// True while a Tuig Git process runs, or ended less than `grace` ago.
pub fn own_git_active(grace: Duration) -> bool {
    own_git_active_at(grace, Instant::now())
}

/// Like [`own_git_active`] with an explicit clock reading.
pub fn own_git_active_at(grace: Duration, now: Instant) -> bool {
    if OWN_GIT_PROCESSES.load(Ordering::SeqCst) > 0 {
        return true;
    }
    let exited = *OWN_GIT_EXITED_AT
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    exited.is_some_and(|at| now.saturating_duration_since(at) < grace)
}

/// Options for [`run_git_with`].
#[derive(Debug, Clone, Default)]
pub struct RunOptions {
    pub cwd: Option<PathBuf>,
    /// Extra environment. `None` removes the variable. Keys listed here win
    /// over [`NON_INTERACTIVE_ENV`].
    pub env: Vec<(String, Option<String>)>,
    pub cancel: Option<CancelToken>,
    /// Fail with [`GitOutputLimitError`] when stdout passes this many bytes.
    pub max_bytes: Option<usize>,
    /// Bytes written to the process's stdin. Without it, stdin is `/dev/null`.
    pub stdin: Option<Vec<u8>>,
}

impl RunOptions {
    pub fn in_dir(cwd: impl AsRef<Path>) -> Self {
        Self {
            cwd: Some(cwd.as_ref().to_path_buf()),
            ..Self::default()
        }
    }
}

/// Run `git` with `args` in `cwd` (or the current directory).
pub async fn run_git<S: AsRef<str>>(
    args: &[S],
    cwd: Option<&Path>,
) -> Result<CommandResult, GitError> {
    let options = RunOptions {
        cwd: cwd.map(Path::to_path_buf),
        ..RunOptions::default()
    };
    run_git_with(args, &options).await
}

/// Run `git` and return its output, or the classified error.
///
/// Dropping the returned future kills the Git process.
pub async fn run_git_with<S: AsRef<str>>(
    args: &[S],
    options: &RunOptions,
) -> Result<CommandResult, GitError> {
    let owned: Vec<String> = args.iter().map(|a| a.as_ref().to_string()).collect();
    if options
        .cancel
        .as_ref()
        .is_some_and(CancelToken::is_cancelled)
    {
        return Err(GitCommandAbortedError { args: owned }.into());
    }
    let _tracked = track_own_git_process();
    run_tracked_git(owned, options).await
}

#[derive(Clone, Copy)]
pub(crate) enum Sig {
    Term,
    Kill,
}

/// Sends signals to a child, or to its whole process group when it leads one.
#[derive(Clone, Copy)]
pub(crate) struct Killer {
    pub(crate) isolated: bool,
    pub(crate) pid: Option<u32>,
}

impl Killer {
    pub(crate) fn send(self, sig: Sig) {
        #[cfg(unix)]
        {
            let signal = match sig {
                Sig::Term => libc::SIGTERM,
                Sig::Kill => libc::SIGKILL,
            };
            let Some(Ok(pid)) = self.pid.map(i32::try_from) else {
                return;
            };
            let target = if self.isolated { -pid } else { pid };
            // SAFETY: kill has no memory effects. A stale pid yields ESRCH, which we ignore.
            unsafe { libc::kill(target, signal) };
        }
        #[cfg(not(unix))]
        {
            let _ = (sig, self.isolated, self.pid);
        }
    }
}

/// Kills the process group when a run is dropped before the child is reaped.
/// `kill_on_drop` alone would only reach Git, not a helper it started.
pub(crate) struct GroupGuard(pub(crate) Option<Killer>);

impl GroupGuard {
    pub(crate) fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(killer) = self.0 {
            killer.send(Sig::Kill);
        }
    }
}

/// Reads stdout in chunks. Returns `None` after the limit was passed, having
/// set `exceeded`.
async fn read_stdout(
    mut pipe: impl AsyncRead + Unpin,
    max_bytes: Option<usize>,
    exceeded: &CancellationToken,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    let mut chunk = vec![0u8; 65536];
    loop {
        let n = match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if max_bytes.is_some_and(|max| output.len() + n > max) {
            exceeded.cancel();
            return Ok(None);
        }
        output.extend_from_slice(&chunk[..n]);
    }
    Ok(Some(output))
}

fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => text.into_owned(),
    }
}

#[cfg(unix)]
fn exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

#[cfg(not(unix))]
fn exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// How long a terminated process group may take to exit before SIGKILL.
const KILL_AFTER: Duration = Duration::from_millis(250);

type Finished = (
    std::io::Result<Option<Vec<u8>>>,
    std::io::Result<Vec<u8>>,
    std::io::Result<ExitStatus>,
);

async fn run_tracked_git(
    args: Vec<String>,
    options: &RunOptions,
) -> Result<CommandResult, GitError> {
    let cancel = options.cancel.as_ref();
    let max_bytes = options.max_bytes;
    // A textconv/credential helper can inherit Git's pipes. Killing only Git
    // leaves those pipes open and makes a cancelled read wait for the helper.
    let isolated = cfg!(unix) && (cancel.is_some() || max_bytes.is_some());

    let mut env: HashMap<&str, Option<&str>> = HashMap::new();
    for (key, value) in NON_INTERACTIVE_ENV {
        if !options.env.iter().any(|(k, _)| k == key) {
            env.insert(key, Some(value));
        }
    }
    for (key, value) in &options.env {
        env.insert(key, value.as_deref());
    }

    let mut command = Command::new("git");
    command.args(&args);
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in env {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
    command
        .stdin(if options.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    if isolated {
        command.process_group(0);
    }

    let mut child = command.spawn().map_err(|source| GitError::Spawn {
        args: args.clone(),
        source,
    })?;
    let killer = Killer {
        isolated,
        pid: child.id(),
    };
    let mut guard = GroupGuard(isolated.then_some(killer));

    let exceeded = CancellationToken::new();
    let stdout_pipe = child.stdout.take().expect("stdout is piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    let stdin_pipe = child.stdin.take();
    let input = options.stdin.as_deref().unwrap_or_default();

    let finished = async {
        let stdout = read_stdout(stdout_pipe, max_bytes, &exceeded);
        let stderr = async {
            let mut bytes = Vec::new();
            stderr_pipe.read_to_end(&mut bytes).await.map(|_| bytes)
        };
        let stdin = async {
            if let Some(mut pipe) = stdin_pipe {
                // Git may exit before reading all input. A broken pipe is not our error.
                let _ = pipe.write_all(input).await;
            }
        };
        let (stdout, stderr, ()) = tokio::join!(stdout, stderr, stdin);
        let status = child.wait().await;
        (stdout, stderr, status)
    };
    let stop = async {
        tokio::select! {
            () = exceeded.cancelled() => {}
            () = async {
                match cancel {
                    Some(cancel) => cancel.cancelled().await,
                    None => std::future::pending().await,
                }
            } => {}
        }
    };
    let mut finished = std::pin::pin!(finished);
    let (stdout, stderr, status): Finished = tokio::select! {
        done = &mut finished => done,
        () = stop => {
            // Ask the group to exit, and kill it if it does not.
            killer.send(Sig::Term);
            match tokio::time::timeout(KILL_AFTER, &mut finished).await {
                Ok(done) => done,
                Err(_) => {
                    killer.send(Sig::Kill);
                    finished.await
                }
            }
        }
    };
    let status = status?;
    guard.disarm();
    let stdout = stdout?;
    let stderr = stderr?;

    let result = CommandResult {
        stdout: stdout.as_deref().map(decode).unwrap_or_default(),
        stderr: decode(&stderr),
        exit_code: exit_code(status),
    };
    if cancel.is_some_and(CancelToken::is_cancelled) {
        return Err(GitCommandAbortedError { args }.into());
    }
    if exceeded.is_cancelled() {
        return Err(GitOutputLimitError {
            args,
            limit_bytes: max_bytes.unwrap_or_default(),
        }
        .into());
    }
    if result.exit_code != 0 {
        return Err(GitCommandError { args, result }.into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_repo;

    #[tokio::test]
    async fn reports_stderr_in_command_errors() {
        let dir = temp_repo().await;
        let error = run_git(&["show", "nope"], Some(dir.path()))
            .await
            .unwrap_err();
        let GitError::Command(error) = error else {
            panic!("expected a command error, got {error:?}");
        };
        assert_eq!(error.args, ["show", "nope"]);
        assert_ne!(error.result.exit_code, 0);
        assert!(error.to_string().starts_with("git show nope: fatal:"));
    }

    #[tokio::test]
    async fn disables_credential_prompts_unless_overridden() {
        let dir = temp_repo().await;
        let alias =
            "alias.show-env=!printf '%s|%s' \"$GIT_TERMINAL_PROMPT\" \"${GIT_ASKPASS-unset}\"";
        let result = run_git(&["-c", alias, "show-env"], Some(dir.path()))
            .await
            .unwrap();
        assert_eq!(result.stdout, "0|");

        let options = RunOptions {
            cwd: Some(dir.path().to_path_buf()),
            env: vec![
                ("GIT_TERMINAL_PROMPT".into(), Some("1".into())),
                ("GIT_ASKPASS".into(), None),
            ],
            ..RunOptions::default()
        };
        let result = run_git_with(&["-c", alias, "show-env"], &options)
            .await
            .unwrap();
        assert_eq!(result.stdout, "1|unset");
    }

    #[tokio::test]
    async fn passes_stdin_to_git() {
        let dir = temp_repo().await;
        let options = RunOptions {
            cwd: Some(dir.path().to_path_buf()),
            stdin: Some(b"hello\n".to_vec()),
            ..RunOptions::default()
        };
        let result = run_git_with(&["hash-object", "--stdin"], &options)
            .await
            .unwrap();
        assert_eq!(
            result.stdout.trim(),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
    }

    #[tokio::test]
    async fn rejects_output_over_the_limit() {
        let dir = temp_repo().await;
        std::fs::write(dir.path().join("big.txt"), "x".repeat(100_000)).unwrap();
        run_git(&["add", "big.txt"], Some(dir.path()))
            .await
            .unwrap();
        let show = ["show", ":big.txt"];
        let mut options = RunOptions::in_dir(dir.path());
        options.max_bytes = Some(1000);
        let error = run_git_with(&show, &options).await.unwrap_err();
        assert!(matches!(
            error,
            GitError::OutputLimit(GitOutputLimitError {
                limit_bytes: 1000,
                ..
            })
        ));
        options.max_bytes = Some(100_000);
        assert_eq!(
            run_git_with(&show, &options).await.unwrap().stdout.len(),
            100_000
        );
    }

    #[tokio::test]
    async fn cancelling_kills_the_whole_process_group() {
        let dir = temp_repo().await;
        let token = CancelToken::new();
        let options = RunOptions {
            cwd: Some(dir.path().to_path_buf()),
            cancel: Some(token.clone()),
            ..RunOptions::default()
        };
        let canceller = tokio::spawn({
            let token = token.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                token.cancel();
            }
        });
        let started = Instant::now();
        let error = run_git_with(&["-c", "alias.nap=!sleep 30", "nap"], &options)
            .await
            .unwrap_err();
        canceller.await.unwrap();
        assert!(matches!(error, GitError::Aborted(_)));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(
            error.to_string(),
            "git -c alias.nap=!sleep 30 nap: cancelled"
        );
    }
}
