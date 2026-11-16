use super::*;
use crate::screens::test_support::{Harness, TempDir, git, repository};
use crate::services::Services;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use tuig_git::pull_request_types::{CheckRollup, PullRequestState, PullRequestUnavailableReason};

fn pr(number: u64, branch: &str, checks: CheckRollup) -> PullRequest {
    PullRequest {
        number,
        title: "Change".into(),
        url: String::new(),
        state: PullRequestState::Open,
        checks,
        author: "ada".into(),
        head_branch: branch.into(),
        head_sha: None,
        from_fork: false,
        mine: true,
        review_requested: false,
        updated_at: String::new(),
    }
}

fn available(list: Vec<PullRequest>) -> PullRequestList {
    PullRequestList::Available {
        pull_requests: list,
    }
}

/// Answers each `list` call from a queue, then repeats the last answer. Counts the calls.
struct FakeService {
    answers: Mutex<VecDeque<PullRequestList>>,
    calls: AtomicUsize,
}

impl FakeService {
    fn new(answers: Vec<PullRequestList>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into()),
            calls: AtomicUsize::new(0),
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl PullRequestService for FakeService {
    async fn list(&self, _cancel: Option<&tuig_git::process::CancelToken>) -> PullRequestList {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut answers = self.answers.lock().unwrap();
        if answers.len() > 1 {
            answers.pop_front().unwrap()
        } else {
            answers.front().cloned().unwrap()
        }
    }
}

fn services(service: &Arc<FakeService>) -> Services {
    Services {
        pull_requests: Some(service.clone()),
        ..Services::default()
    }
}

#[test]
fn a_pull_request_on_the_checked_out_branch_shows_in_the_history_column() {
    let service = FakeService::new(vec![available(vec![pr(12, "main", CheckRollup::Passed)])]);
    let h = Harness::start(repository(3), services(&service));
    h.wait("the pull request column", |shell| {
        shell.history.window.as_ref().is_some_and(|window| {
            window.pr_column
                && window
                    .rows
                    .first()
                    .is_some_and(|row| !row.pull_requests.is_empty())
        })
    });
    h.read(|shell| {
        let window = shell.history.window.as_ref().unwrap();
        assert_eq!(
            window.rows[0].pull_requests[0].number, 12,
            "HEAD carries the branch label"
        );
        assert!(
            window.rows[1].pull_requests.is_empty(),
            "older commits do not"
        );
    });
    let screen = h.app.render();
    assert!(screen.text().contains("#12 ✓"), "{screen}");
}

#[test]
fn a_missing_gh_or_login_hides_the_column() {
    for reason in [
        PullRequestUnavailableReason::GhMissing,
        PullRequestUnavailableReason::NotAuthenticated,
        PullRequestUnavailableReason::NotGithub,
        PullRequestUnavailableReason::Error,
    ] {
        let service = FakeService::new(vec![PullRequestList::Unavailable {
            reason,
            message: Some("nope".into()),
        }]);
        let h = Harness::start(repository(2), services(&service));
        h.wait("the answer", |shell| shell.pr.result.is_some());
        h.wait("the first snapshot", |shell| shell.snapshot.is_some());
        assert!(!h.read(|shell| shell.pr_column_available()), "{reason:?}");
        assert!(!h.read(|shell| shell.history.window.as_ref().unwrap().pr_column));
    }
}

#[test]
fn the_list_refreshes_after_a_minute_while_checks_run_and_the_spinner_follows_them() {
    let service = FakeService::new(vec![
        available(vec![pr(12, "main", CheckRollup::Running)]),
        available(vec![pr(12, "main", CheckRollup::Passed)]),
    ]);
    let h = Harness::start(repository(3), services(&service));
    h.wait("running checks on screen", |shell| {
        shell
            .history
            .window
            .as_ref()
            .is_some_and(|w| w.running_checks_visible(40))
    });
    h.wait("the spinner timer", |shell| {
        shell.pr.spinner_timer.is_some()
    });
    h.app.advance(SPINNER_INTERVAL * 3);
    h.wait("a later spinner frame", |shell| shell.pr.spinner_frame > 0);

    // Fewer than 60 seconds: no new request. Then the refresh timer fires.
    h.app.advance(ACTIVE_REFRESH - Duration::from_secs(5));
    assert_eq!(service.calls(), 1);
    h.app.advance(Duration::from_secs(5));
    h.wait("the second list", |shell| {
        shell
            .pr
            .pull_requests()
            .first()
            .is_some_and(|pr| pr.checks == CheckRollup::Passed)
    });
    assert_eq!(service.calls(), 2);
    h.send(Msg::SpinnerTick);
    assert!(
        h.read(|shell| shell.pr.spinner_timer.is_none()),
        "no running checks, no timer"
    );
    assert_eq!(h.read(|shell| shell.pr.spinner_frame), 0);

    // Settled checks wait three minutes.
    h.app.advance(IDLE_REFRESH - Duration::from_secs(1));
    assert_eq!(service.calls(), 2);
    h.app.advance(Duration::from_secs(1));
    h.wait("the third list", |_| service.calls() == 3);
}

#[test]
fn a_periodic_fetch_brings_in_remote_branches() {
    let repo = repository(2);
    let remote = TempDir::new("remote");
    git(
        &repo.0,
        &["clone", "-q", "--bare", ".", remote.0.to_str().unwrap()],
    );
    git(
        &repo.0,
        &["remote", "add", "origin", remote.0.to_str().unwrap()],
    );
    let service = FakeService::new(vec![available(vec![])]);
    let interval = Duration::from_secs(60);
    let h = Harness::start(
        repo,
        Services {
            fetch_interval: Some(interval),
            ..services(&service)
        },
    );
    h.wait("the first snapshot", |shell| shell.snapshot.is_some());
    assert!(h.read(|shell| {
        shell
            .snapshot
            .as_ref()
            .unwrap()
            .branches
            .iter()
            .all(|b| !b.remote)
    }));

    // The 30 second safety-net poll runs first. A fetch is skipped while a snapshot read runs.
    h.app.advance(interval / 2);
    h.wait("the poll's snapshot", |shell| !shell.tasks.snapshot.busy());
    h.app.advance(interval / 2);
    h.wait("the remote branch", |shell| {
        shell
            .snapshot
            .as_ref()
            .is_some_and(|s| s.branches.iter().any(|b| b.name == "origin/main"))
    });
}
