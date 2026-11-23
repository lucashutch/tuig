//! Lists open pull requests with the GitHub CLI and rolls their checks up into
//! one status. Port of `src/git/pull-requests.ts`.
//!
//! Differences from the TypeScript code:
//! - [`PullRequestService::list`] cannot fail, so a cancelled request comes
//!   back as `Unavailable { reason: Error }`. Use
//!   [`GhPullRequestService::try_list`] to tell a cancel from a real error.
//! - `updated_at` sorting parses RFC 3339 timestamps only. A timestamp without
//!   a zone counts as UTC, where JavaScript would use local time.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::process::{CancelToken, GroupGuard, Killer, Sig};
use crate::pull_request_types::{
    CheckRollup, PullRequest, PullRequestList, PullRequestService, PullRequestState,
    PullRequestUnavailableReason,
};
use crate::types::CommandResult;

#[derive(Debug, Clone)]
pub struct GhRunOptions {
    pub cwd: PathBuf,
    pub cancel: Option<CancelToken>,
}

/// A boxed future that can move between tasks.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why `gh` produced no exit code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GhError {
    /// `gh` is not installed.
    #[error("GitHub CLI (gh) was not found.")]
    NotFound,
    /// `gh` ran longer than the timeout.
    #[error("GitHub CLI timed out after {} s.", (.0.as_secs_f64()).round())]
    Timeout(Duration),
    #[error("The pull request request was cancelled.")]
    Cancelled,
    #[error("{0}")]
    Io(String),
}

/// Runs `gh` with the given arguments. It returns the exit code for any exit,
/// and fails when `gh` cannot start, times out, or is cancelled.
///
/// The runner owns its arguments so the future it returns borrows nothing.
pub type GhRunner = Box<
    dyn Fn(Vec<String>, GhRunOptions) -> BoxFuture<'static, Result<CommandResult, GhError>>
        + Send
        + Sync,
>;

pub const GH_TIMEOUT: Duration = Duration::from_secs(15);

/// `gh` must never prompt, page, color, or animate: Tuig owns the terminal.
pub const GH_NON_INTERACTIVE_ENV: [(&str, &str); 6] = [
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_PAGER", "cat"),
    ("GH_SPINNER_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1"),
    ("NO_COLOR", "1"),
];

/// One GraphQL request for the signed-in login, the open pull requests, and the
/// ones that ask for the user's review. Checks come as counts per state, which
/// GitHub answers much faster than the full check list `gh pr list` asks for.
const LIST_QUERY: &str = "query($owner: String!, $repo: String!, $review: String!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft updatedAt
        author { login }
        headRefName headRefOid isCrossRepository
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts {
          checkRunCountsByState { state count }
          statusContextCountsByState { state count }
        } } } } }
      }
    }
  }
  review: search(query: $review, type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number } }
  }
}";

/// `gh` fills `{owner}` and `{repo}` from the repository's GitHub remote.
fn list_args() -> Vec<String> {
    [
        "api",
        "graphql",
        "-F",
        "owner={owner}",
        "-F",
        "repo={repo}",
        "-F",
        "review=repo:{owner}/{repo} is:pr is:open review-requested:@me",
        "-f",
    ]
    .iter()
    .map(ToString::to_string)
    .chain([format!("query={LIST_QUERY}")])
    .collect()
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
    status.code().unwrap_or(-1)
}

async fn drain(mut pipe: impl AsyncRead + Unpin) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = pipe.read_to_end(&mut bytes).await;
    bytes
}

/// Run `program` without a terminal. Kills its whole process group on timeout
/// or cancel so a helper cannot keep the output pipes open. Dropping the
/// future kills the group too.
pub async fn run_program(
    program: &str,
    args: &[String],
    options: &GhRunOptions,
    timeout: Duration,
) -> Result<CommandResult, GhError> {
    let cancel = options.cancel.as_ref();
    if cancel.is_some_and(CancelToken::is_cancelled) {
        return Err(GhError::Cancelled);
    }
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(&options.cwd)
        .envs(GH_NON_INTERACTIVE_ENV)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            GhError::NotFound
        } else {
            GhError::Io(error.to_string())
        }
    })?;
    let killer = Killer {
        isolated: cfg!(unix),
        pid: child.id(),
    };
    let mut guard = GroupGuard(Some(killer));
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let finished = async {
        let (stdout, stderr) = tokio::join!(drain(stdout), drain(stderr));
        (stdout, stderr, child.wait().await)
    };
    let mut finished = std::pin::pin!(finished);
    let mut timed_out = false;
    let (stdout, stderr, status) = tokio::select! {
        done = &mut finished => done,
        () = async {
            match cancel {
                Some(cancel) => cancel.cancelled().await,
                None => std::future::pending().await,
            }
        } => {
            killer.send(Sig::Kill);
            finished.await
        }
        () = tokio::time::sleep(timeout) => {
            timed_out = true;
            killer.send(Sig::Kill);
            finished.await
        }
    };
    guard.disarm();
    let status = status.map_err(|error| GhError::Io(error.to_string()))?;
    if cancel.is_some_and(CancelToken::is_cancelled) {
        return Err(GhError::Cancelled);
    }
    if timed_out {
        return Err(GhError::Timeout(timeout));
    }
    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code: exit_code(status),
    })
}

/// The default runner: the real `gh` with a 15 s timeout.
pub async fn run_gh(args: Vec<String>, options: GhRunOptions) -> Result<CommandResult, GhError> {
    run_program("gh", &args, &options, GH_TIMEOUT).await
}

/// The caller cancelled the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("The pull request request was cancelled.")]
pub struct PullRequestCancelled;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Failure {
    reason: PullRequestUnavailableReason,
    message: Option<String>,
}

impl Failure {
    fn reason(reason: PullRequestUnavailableReason) -> Self {
        Self {
            reason,
            message: None,
        }
    }

    fn error(message: String) -> Self {
        Self {
            reason: PullRequestUnavailableReason::Error,
            message: Some(message),
        }
    }

    fn into_list(self) -> PullRequestList {
        PullRequestList::Unavailable {
            reason: self.reason,
            message: self.message,
        }
    }
}

fn shorten(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() > 160 {
        let head: String = line.chars().take(157).collect();
        format!("{head}...")
    } else {
        line.to_string()
    }
}

fn describe_failure(error: &GhError) -> Failure {
    match error {
        GhError::NotFound => Failure::reason(PullRequestUnavailableReason::GhMissing),
        other => Failure::error(shorten(&other.to_string())),
    }
}

fn classify_exit(result: &CommandResult) -> Failure {
    let stderr = result.stderr.to_lowercase();
    // Checked first: this message also tells the user to run `gh auth login`.
    if stderr.contains("known github host") || stderr.contains("no github remote") {
        return Failure::reason(PullRequestUnavailableReason::NotGithub);
    }
    if result.exit_code == 4
        || stderr.contains("gh auth login")
        || stderr.contains("bad credentials")
        || stderr.contains("http 401")
    {
        return Failure::reason(PullRequestUnavailableReason::NotAuthenticated);
    }
    let message = shorten(&result.stderr);
    Failure::error(if message.is_empty() {
        format!("GitHub CLI exited with code {}.", result.exit_code)
    } else {
        message
    })
}

/// Pull request access through `gh api graphql`.
pub struct GhPullRequestService {
    root: std::path::PathBuf,
    runner: GhRunner,
    /// `GhMissing` and `NotGithub` do not change while Tuig runs.
    permanent: Mutex<Option<Failure>>,
}

impl GhPullRequestService {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self::with_runner(
            root,
            Box::new(|args, options| Box::pin(run_gh(args, options))),
        )
    }

    pub fn with_runner(root: impl AsRef<Path>, runner: GhRunner) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
            runner,
            permanent: Mutex::new(None),
        }
    }

    /// Runs the query and returns its `data`, or the failure.
    async fn query(
        &self,
        cancel: Option<&CancelToken>,
    ) -> Result<Result<Map<String, Value>, Failure>, PullRequestCancelled> {
        let options = GhRunOptions {
            cwd: self.root.clone(),
            cancel: cancel.cloned(),
        };
        let result = match (self.runner)(list_args(), options).await {
            Ok(result) => result,
            Err(error) => {
                if cancel.is_some_and(CancelToken::is_cancelled) {
                    return Err(PullRequestCancelled);
                }
                return Ok(Err(describe_failure(&error)));
            }
        };
        let data = parse_data(&result.stdout);
        // A failed review search exits non-zero but still returns the list.
        if let Some(data) = data
            && data.get("repository").is_some_and(Value::is_object)
        {
            return Ok(Ok(data));
        }
        if result.exit_code != 0 {
            return Ok(Err(classify_exit(&result)));
        }
        Ok(Err(Failure::error(
            "GitHub CLI returned unreadable pull request data.".to_string(),
        )))
    }

    /// Like [`PullRequestService::list`], but reports a cancel as an error.
    pub async fn try_list(
        &self,
        cancel: Option<&CancelToken>,
    ) -> Result<PullRequestList, PullRequestCancelled> {
        let known = self
            .permanent
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(failure) = known {
            return Ok(failure.into_list());
        }
        let data = match self.query(cancel).await? {
            Ok(data) => data,
            Err(failure) => {
                if matches!(
                    failure.reason,
                    PullRequestUnavailableReason::GhMissing
                        | PullRequestUnavailableReason::NotGithub
                ) {
                    *self
                        .permanent
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(failure.clone());
                }
                return Ok(failure.into_list());
            }
        };
        let login = data
            .get("viewer")
            .and_then(|viewer| viewer.get("login"))
            .and_then(Value::as_str)
            .map(str::to_lowercase);
        let requested: HashSet<u64> = nodes(data.get("review"))
            .into_iter()
            .filter_map(|node| node.get("number").and_then(integer))
            .collect();
        let mut parsed: Vec<(Option<i64>, PullRequest)> =
            nodes(data.get("repository").and_then(|r| r.get("pullRequests")))
                .into_iter()
                .filter_map(|entry| parse_pull_request(entry, login.as_deref(), &requested))
                .map(|pr| (parse_time_ms(&pr.updated_at), pr))
                .collect();
        // Newest first. An unparseable time sorts last. The sort is stable.
        parsed.sort_by_key(|entry| std::cmp::Reverse(entry.0));
        Ok(PullRequestList::Available {
            pull_requests: parsed.into_iter().map(|(_, pr)| pr).collect(),
        })
    }
}

#[async_trait]
impl PullRequestService for GhPullRequestService {
    async fn list(&self, cancel: Option<&CancelToken>) -> PullRequestList {
        self.try_list(cancel)
            .await
            .unwrap_or_else(|cancelled| Failure::error(cancelled.to_string()).into_list())
    }
}

/// JSON number with an integer value, like `Number.isInteger`.
fn integer(value: &Value) -> Option<u64> {
    let number = value.as_number()?;
    if let Some(n) = number.as_u64() {
        return Some(n);
    }
    let float = number.as_f64()?;
    (float.fract() == 0.0 && float >= 0.0 && float < u64::MAX as f64).then_some(float as u64)
}

fn parse_data(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text).ok()?.get("data")? {
        Value::Object(map) => Some(map.clone()),
        _ => None,
    }
}

/// The `nodes` array of a GraphQL connection, or none.
fn nodes(connection: Option<&Value>) -> Vec<&Value> {
    connection
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| nodes.iter().collect())
        .unwrap_or_default()
}

/// Returns `None` for an entry that lacks a field the UI cannot do without.
fn parse_pull_request(
    entry: &Value,
    login: Option<&str>,
    requested: &HashSet<u64>,
) -> Option<PullRequest> {
    let raw = entry.as_object()?;
    let number = integer(raw.get("number")?)?;
    let title = raw.get("title")?.as_str()?;
    let url = raw.get("url")?.as_str()?;
    let head_branch = raw.get("headRefName")?.as_str().filter(|b| !b.is_empty())?;
    let updated_at = raw.get("updatedAt")?.as_str()?;
    // GitHub reports deleted accounts as null.
    let author = raw
        .get("author")
        .and_then(|a| a.get("login"))
        .and_then(Value::as_str)
        .unwrap_or("ghost");
    let head_sha = raw
        .get("headRefOid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let contexts = nodes(raw.get("commits"))
        .first()
        .and_then(|node| node.get("commit"))
        .and_then(|commit| commit.get("statusCheckRollup"))
        .and_then(|rollup| rollup.get("contexts"));
    Some(PullRequest {
        number,
        title: title.to_string(),
        url: url.to_string(),
        state: if raw.get("isDraft") == Some(&Value::Bool(true)) {
            PullRequestState::Draft
        } else {
            PullRequestState::Open
        },
        checks: rollup_check_counts(contexts),
        author: author.to_string(),
        head_branch: head_branch.to_string(),
        head_sha: head_sha.map(ToString::to_string),
        from_fork: raw.get("isCrossRepository") == Some(&Value::Bool(true)),
        mine: login.is_some_and(|login| author.to_lowercase() == login),
        review_requested: requested.contains(&number),
        updated_at: updated_at.to_string(),
    })
}

#[derive(Clone, Copy)]
enum CheckState {
    Failed,
    Running,
    Queued,
    Passed,
}

/// Sorts a check run state. A finished run reports its conclusion as its state.
/// FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STALE, STARTUP_FAILURE, and
/// COMPLETED without a conclusion count as failed. Counts cannot tell a new
/// in-flight value from a new final one, so unknown values count as running,
/// which never shows green and keeps the faster refresh.
fn check_run_state(state: &str) -> CheckState {
    match state {
        "SUCCESS" | "SKIPPED" | "NEUTRAL" => CheckState::Passed,
        "QUEUED" | "WAITING" | "PENDING" | "REQUESTED" => CheckState::Queued,
        "IN_PROGRESS" => CheckState::Running,
        "COMPLETED" | "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STALE"
        | "STARTUP_FAILURE" => CheckState::Failed,
        _ => CheckState::Running,
    }
}

/// Sorts a commit status state.
fn status_context_state(state: &str) -> CheckState {
    match state {
        "SUCCESS" => CheckState::Passed,
        "FAILURE" | "ERROR" => CheckState::Failed,
        "EXPECTED" => CheckState::Queued,
        // A commit status has no queued or running split. External CI usually
        // reports PENDING once the build starts, so it counts as running.
        _ => CheckState::Running,
    }
}

/// Combines the check counts of a `statusCheckRollup.contexts` connection into
/// one status. The rules and their order are documented on [`CheckRollup`].
/// Malformed entries are ignored.
pub fn rollup_check_counts(contexts: Option<&Value>) -> CheckRollup {
    let (mut failed, mut running, mut queued, mut passed) = (0.0, 0.0, 0.0, 0.0);
    let mut add = |key: &str, sort: fn(&str) -> CheckState| {
        let Some(entries) = contexts.and_then(|c| c.get(key)).and_then(Value::as_array) else {
            return;
        };
        for entry in entries {
            let state = entry.get("state").and_then(Value::as_str);
            let count = entry.get("count").and_then(Value::as_f64);
            if let (Some(state), Some(count)) = (state, count)
                && !state.is_empty()
                && count > 0.0
            {
                match sort(&state.to_uppercase()) {
                    CheckState::Failed => failed += count,
                    CheckState::Running => running += count,
                    CheckState::Queued => queued += count,
                    CheckState::Passed => passed += count,
                }
            }
        }
    };
    add("checkRunCountsByState", check_run_state);
    add("statusContextCountsByState", status_context_state);
    if failed > 0.0 {
        CheckRollup::Failed
    } else if running > 0.0 {
        CheckRollup::Running
    } else if queued > 0.0 {
        if passed > 0.0 {
            CheckRollup::Tentative
        } else {
            CheckRollup::Pending
        }
    } else if passed > 0.0 {
        CheckRollup::Passed
    } else {
        CheckRollup::None
    }
}

/// Days from 1970-01-01 to a civil date (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Milliseconds since the epoch for `YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|+HH:MM]`.
fn parse_time_ms(text: &str) -> Option<i64> {
    fn digits(s: &str, len: usize) -> Option<(i64, &str)> {
        let head = s.get(..len)?;
        head.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| (head.parse().ok().unwrap_or(0), &s[len..]))
    }
    let (year, rest) = digits(text, 4)?;
    let (month, rest) = digits(rest.strip_prefix('-')?, 2)?;
    let (day, mut rest) = digits(rest.strip_prefix('-')?, 2)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0);
    if let Some(time) = rest.strip_prefix(['T', ' ']) {
        let (h, r) = digits(time, 2)?;
        let (m, r) = digits(r.strip_prefix(':')?, 2)?;
        (hour, minute, rest) = (h, m, r);
        if let Some(r) = rest.strip_prefix(':') {
            let (s, r) = digits(r, 2)?;
            (second, rest) = (s, r);
            if let Some(fraction) = rest.strip_prefix('.') {
                let len = fraction.bytes().take_while(u8::is_ascii_digit).count();
                if len == 0 {
                    return None;
                }
                let first3 = format!("{:0<3}", &fraction[..len.min(3)]);
                millis = first3.parse().ok()?;
                rest = &fraction[len..];
            }
        }
    }
    let offset_minutes = if rest.is_empty() || rest == "Z" {
        0
    } else {
        let sign = match rest.as_bytes()[0] {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let (oh, r) = digits(&rest[1..], 2)?;
        let (om, r) = digits(r.strip_prefix(':').unwrap_or(r), 2)?;
        if !r.is_empty() {
            return None;
        }
        sign * (oh * 60 + om)
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
        - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn counts(states: &[&str]) -> Value {
        Value::Array(
            states
                .iter()
                .map(|state| json!({"state": state, "count": 1}))
                .collect(),
        )
    }
    fn runs(states: &[&str]) -> Value {
        json!({"checkRunCountsByState": counts(states), "statusContextCountsByState": []})
    }
    fn statuses(states: &[&str]) -> Value {
        json!({"checkRunCountsByState": [], "statusContextCountsByState": counts(states)})
    }
    fn both(check_runs: &[&str], contexts: &[&str]) -> Value {
        json!({"checkRunCountsByState": counts(check_runs), "statusContextCountsByState": counts(contexts)})
    }

    #[test]
    fn rollup_check_counts_follows_the_documented_rules() {
        use CheckRollup as R;
        let cases: Vec<(&str, Option<Value>, CheckRollup)> = vec![
            ("no rollup", None, R::None),
            ("no checks", Some(runs(&[])), R::None),
            (
                "zero counts are ignored",
                Some(json!({"checkRunCountsByState": [
                    {"state": "FAILURE", "count": 0},
                    {"state": "SUCCESS", "count": 2},
                ]})),
                R::Passed,
            ),
            (
                "skipped and neutral count as passed",
                Some(runs(&["SKIPPED", "NEUTRAL"])),
                R::Passed,
            ),
            (
                "one failure",
                Some(runs(&["SUCCESS", "FAILURE"])),
                R::Failed,
            ),
            ("cancelled", Some(runs(&["CANCELLED"])), R::Failed),
            ("timed out", Some(runs(&["TIMED_OUT"])), R::Failed),
            (
                "action required",
                Some(runs(&["ACTION_REQUIRED"])),
                R::Failed,
            ),
            ("stale", Some(runs(&["STALE"])), R::Failed),
            (
                "startup failure",
                Some(runs(&["STARTUP_FAILURE"])),
                R::Failed,
            ),
            (
                "completed without conclusion",
                Some(runs(&["COMPLETED"])),
                R::Failed,
            ),
            (
                "failed beats running",
                Some(runs(&["IN_PROGRESS", "FAILURE"])),
                R::Failed,
            ),
            (
                "failed beats queued",
                Some(runs(&["QUEUED", "FAILURE"])),
                R::Failed,
            ),
            (
                "running beats tentative",
                Some(runs(&["SUCCESS", "QUEUED", "IN_PROGRESS"])),
                R::Running,
            ),
            (
                "passed plus queued is tentative",
                Some(runs(&["SUCCESS", "QUEUED"])),
                R::Tentative,
            ),
            (
                "passed plus waiting is tentative",
                Some(runs(&["NEUTRAL", "WAITING"])),
                R::Tentative,
            ),
            (
                "passed plus requested is tentative",
                Some(runs(&["SUCCESS", "REQUESTED"])),
                R::Tentative,
            ),
            (
                "all queued is pending",
                Some(runs(&["QUEUED", "PENDING"])),
                R::Pending,
            ),
            (
                "unknown state never counts as passed",
                Some(runs(&["SUCCESS", "SOMETHING_NEW"])),
                R::Running,
            ),
            (
                "status context success",
                Some(statuses(&["SUCCESS"])),
                R::Passed,
            ),
            (
                "status context failure",
                Some(statuses(&["FAILURE"])),
                R::Failed,
            ),
            (
                "status context error",
                Some(statuses(&["ERROR"])),
                R::Failed,
            ),
            (
                "status context pending counts as running",
                Some(both(&["SUCCESS"], &["PENDING"])),
                R::Running,
            ),
            (
                "status context expected counts as queued",
                Some(statuses(&["EXPECTED"])),
                R::Pending,
            ),
            (
                "status context expected after a pass is tentative",
                Some(both(&["SUCCESS"], &["EXPECTED"])),
                R::Tentative,
            ),
            (
                "malformed entries are ignored",
                Some(json!({
                    "checkRunCountsByState": [null, 7, {"state": "FAILURE"}, {"count": 3}],
                    "statusContextCountsByState": "x",
                })),
                R::None,
            ),
        ];
        for (name, contexts, expected) in cases {
            assert_eq!(rollup_check_counts(contexts.as_ref()), expected, "{name}");
        }
    }

    fn ok(stdout: &str) -> Result<CommandResult, GhError> {
        Ok(CommandResult {
            stdout: stdout.to_string(),
            stderr: String::new(),
            exit_code: 0,
        })
    }
    fn fail(stderr: &str, exit_code: i32, stdout: &str) -> Result<CommandResult, GhError> {
        Ok(CommandResult {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            exit_code,
        })
    }

    fn list_data() -> Value {
        json!({
            "viewer": {"login": "Lucashutch"},
            "repository": {"pullRequests": {"nodes": [
                {
                    "number": 12, "title": "Older draft",
                    "url": "https://github.com/acme/app/pull/12",
                    "isDraft": true, "author": {"login": "lucashutch"},
                    "headRefName": "draft-work", "headRefOid": "aaa111",
                    "isCrossRepository": false, "updatedAt": "2026-10-01T10:00:00Z",
                    "commits": {"nodes": [{"commit": {"statusCheckRollup": null}}]},
                },
                {
                    "number": 15, "title": "Fork change",
                    "url": "https://github.com/acme/app/pull/15",
                    "isDraft": false, "author": {"login": "outsider"},
                    "headRefName": "patch-1", "headRefOid": "bbb222",
                    "isCrossRepository": true, "updatedAt": "2026-10-05T10:00:00Z",
                    "commits": {"nodes": [{"commit": {"statusCheckRollup": {
                        "contexts": both(&["SUCCESS"], &["PENDING"]),
                    }}}]},
                },
                {"number": "bad", "title": 3},
                null,
            ]}},
            "review": {"nodes": [{"number": 15}, {}]},
        })
    }
    fn list_json() -> String {
        json!({"data": list_data()}).to_string()
    }

    type Calls = Arc<Mutex<Vec<Vec<String>>>>;

    fn fake_gh(
        answer: impl Fn() -> Result<CommandResult, GhError> + Send + Sync + 'static,
    ) -> (GhPullRequestService, Calls) {
        let calls: Calls = Arc::default();
        let recorded = calls.clone();
        let runner: GhRunner = Box::new(move |args, options| {
            recorded.lock().unwrap().push(args);
            assert_eq!(options.cwd, Path::new("/repo"));
            let result = answer();
            Box::pin(async move { result })
        });
        (GhPullRequestService::with_runner("/repo", runner), calls)
    }

    fn unavailable(reason: PullRequestUnavailableReason) -> PullRequestList {
        PullRequestList::Unavailable {
            reason,
            message: None,
        }
    }

    #[tokio::test]
    async fn lists_open_pull_requests_newest_first_with_mine_review_and_fork_flags() {
        let (service, calls) = fake_gh(|| ok(&list_json()));
        let expected = PullRequestList::Available {
            pull_requests: vec![
                PullRequest {
                    number: 15,
                    title: "Fork change".into(),
                    url: "https://github.com/acme/app/pull/15".into(),
                    state: PullRequestState::Open,
                    checks: CheckRollup::Running,
                    author: "outsider".into(),
                    head_branch: "patch-1".into(),
                    head_sha: Some("bbb222".into()),
                    from_fork: true,
                    mine: false,
                    review_requested: true,
                    updated_at: "2026-10-05T10:00:00Z".into(),
                },
                PullRequest {
                    number: 12,
                    title: "Older draft".into(),
                    url: "https://github.com/acme/app/pull/12".into(),
                    state: PullRequestState::Draft,
                    checks: CheckRollup::None,
                    author: "lucashutch".into(),
                    head_branch: "draft-work".into(),
                    head_sha: Some("aaa111".into()),
                    from_fork: false,
                    mine: true,
                    review_requested: false,
                    updated_at: "2026-10-01T10:00:00Z".into(),
                },
            ],
        };
        assert_eq!(service.list(None).await, expected);
        // One request lists pull requests, the login, and review requests.
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(&calls[0][..2], ["api", "graphql"]);
        assert!(calls[0].iter().any(|a| a.starts_with("query=query(")));
    }

    #[tokio::test]
    async fn keeps_the_list_when_the_review_requested_search_fails() {
        let mut data = list_data();
        data["review"] = Value::Null;
        let stdout = json!({"data": data}).to_string();
        let (service, _) = fake_gh(move || {
            fail(
                "gh: Something went wrong while executing your query.\n",
                1,
                &stdout,
            )
        });
        let PullRequestList::Available { pull_requests } = service.list(None).await else {
            panic!("expected an available list");
        };
        let flags: Vec<bool> = pull_requests.iter().map(|pr| pr.review_requested).collect();
        assert_eq!(flags, [false, false]);
    }

    #[tokio::test]
    async fn reports_gh_missing_and_does_not_run_gh_again() {
        let (service, calls) = fake_gh(|| Err(GhError::NotFound));
        let expected = unavailable(PullRequestUnavailableReason::GhMissing);
        assert_eq!(service.list(None).await, expected);
        assert_eq!(service.list(None).await, expected);
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn reports_not_authenticated_and_retries_on_the_next_list() {
        let logged_in = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = logged_in.clone();
        let (service, _) = fake_gh(move || {
            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                ok(&list_json())
            } else {
                fail("gh: Bad credentials (HTTP 401)\n", 1, "")
            }
        });
        assert_eq!(
            service.list(None).await,
            unavailable(PullRequestUnavailableReason::NotAuthenticated)
        );
        logged_in.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(
            service.list(None).await,
            PullRequestList::Available { .. }
        ));
    }

    #[tokio::test]
    async fn reports_not_github_even_though_gh_suggests_logging_in() {
        let stderr = "error parsing \"owner\" value: none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n";
        let (service, calls) = fake_gh(move || fail(stderr, 1, ""));
        let expected = unavailable(PullRequestUnavailableReason::NotGithub);
        assert_eq!(service.list(None).await, expected);
        assert_eq!(service.list(None).await, expected);
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_cancelled_request_is_an_error_not_an_empty_list() {
        let token = CancelToken::new();
        let inner = token.clone();
        let (service, _) = fake_gh(move || {
            inner.cancel();
            Err(GhError::Io("killed".into()))
        });
        assert_eq!(
            service.try_list(Some(&token)).await,
            Err(PullRequestCancelled)
        );
    }

    #[tokio::test]
    async fn run_program_kills_a_run_that_exceeds_the_timeout() {
        let options = GhRunOptions {
            cwd: PathBuf::from("/"),
            cancel: None,
        };
        let args = ["30".to_string()];
        let result = run_program("sleep", &args, &options, Duration::from_millis(100)).await;
        assert_eq!(result, Err(GhError::Timeout(Duration::from_millis(100))));
    }
}
