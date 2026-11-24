//! Pull request presentation: icons, sidebar grouping, branch matching and the history PR cell. Ports
//! `src/ui/pull-requests.ts`.

use crate::decorations::RefIndex;
use std::collections::{HashMap, HashSet};
use tuig_git::pull_request_types::{
    CheckRollup, PullRequest, PullRequestList, PullRequestState, PullRequestUnavailableReason,
};
use tuig_git::types::{BranchRef, Commit};
use tuig_ui_model::color::Rgba;
use tuig_ui_model::text_width::string_width;
use tuig_ui_model::theme::Theme;

/// Nerd Font octicon git-pull-request.
pub const PULL_REQUEST_OPEN_ICON: &str = "\u{f407}";
/// Nerd Font octicon git-pull-request-draft.
pub const PULL_REQUEST_DRAFT_ICON: &str = "\u{f4dd}";
/// Nerd Font octicon eye, marking pull requests that ask for your review.
pub const PULL_REQUEST_REVIEW_ICON: &str = "\u{f441}";

/// Braille spinner frames for running checks. `BRAILLE_SPINNER_FRAMES` in `runtime-notifications.ts`.
pub const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Check states that can still change, so the list is read again sooner. `UNSETTLED_CHECKS`.
pub fn is_unsettled(checks: CheckRollup) -> bool {
    matches!(
        checks,
        CheckRollup::Running | CheckRollup::Pending | CheckRollup::Tentative
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestGlyph {
    pub glyph: String,
    pub color: Rgba,
}

/// Icons and colors for one pull request. Every glyph is one cell wide.
///
/// Tentative checks use the passed glyph in a dimmer success color, because they have passed so far but some
/// checks have not started.
pub fn pull_request_icons(
    state: PullRequestState,
    checks: CheckRollup,
    theme: &Theme,
    spinner_frame: &str,
) -> (PullRequestGlyph, PullRequestGlyph) {
    let glyph = |glyph: &str, color| PullRequestGlyph {
        glyph: glyph.to_string(),
        color,
    };
    let state = match state {
        PullRequestState::Draft => glyph(PULL_REQUEST_DRAFT_ICON, theme.muted),
        PullRequestState::Open => glyph(PULL_REQUEST_OPEN_ICON, theme.added),
    };
    let checks = match checks {
        CheckRollup::Failed => glyph("✗", theme.deleted),
        CheckRollup::Running => glyph(spinner_frame, theme.warning),
        CheckRollup::Tentative => glyph("✓", mix_color(theme.added, theme.bg, 0.5)),
        CheckRollup::Passed => glyph("✓", theme.added),
        CheckRollup::Pending => glyph("…", theme.muted),
        CheckRollup::None => glyph("·", theme.muted),
    };
    (state, checks)
}

/// Blends two colors channel by channel. `Math.round` rounds halves up, as `floor(x + 0.5)` does.
pub fn mix_color(color: Rgba, toward: Rgba, amount: f64) -> Rgba {
    let channel = |from: u8, to: u8| {
        let (from, to) = (f64::from(from), f64::from(to));
        (from + (to - from) * amount + 0.5)
            .floor()
            .clamp(0.0, 255.0) as u8
    };
    Rgba::rgb(
        channel(color.r, toward.r),
        channel(color.g, toward.g),
        channel(color.b, toward.b),
    )
}

/// Highest number first. GitHub numbers pull requests in creation order.
fn newest_first(a: &PullRequest, b: &PullRequest) -> std::cmp::Ordering {
    b.number.cmp(&a.number)
}

/// Pull requests for the sidebar: yours first, then those that ask for your review, each newest first. A pull
/// request in both groups is listed once, with yours.
pub fn sidebar_pull_requests(pull_requests: &[PullRequest]) -> Vec<PullRequest> {
    let mut mine: Vec<PullRequest> = pull_requests.iter().filter(|pr| pr.mine).cloned().collect();
    let mut reviews: Vec<PullRequest> = pull_requests
        .iter()
        .filter(|pr| pr.review_requested && !pr.mine)
        .cloned()
        .collect();
    mine.sort_by(newest_first);
    reviews.sort_by(newest_first);
    mine.extend(reviews);
    mine
}

/// What the sidebar's pull request section shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PullRequestPanel {
    Hidden,
    Loading,
    Message(String),
    List(Vec<PullRequest>),
}

/// The section is hidden when the feature is off, and when `gh` is missing, signed out, or the repository is not
/// on GitHub. Other failures show their message so the reader knows why the list is empty.
pub fn pull_request_panel(enabled: bool, result: Option<&PullRequestList>) -> PullRequestPanel {
    if !enabled {
        return PullRequestPanel::Hidden;
    }
    match result {
        None => PullRequestPanel::Loading,
        Some(PullRequestList::Available { pull_requests }) => {
            PullRequestPanel::List(sidebar_pull_requests(pull_requests))
        }
        Some(PullRequestList::Unavailable { reason, message }) => {
            if *reason == PullRequestUnavailableReason::Error {
                PullRequestPanel::Message(
                    message
                        .clone()
                        .unwrap_or_else(|| "Could not load pull requests".to_string()),
                )
            } else {
                PullRequestPanel::Hidden
            }
        }
    }
}

/// Rows the panel takes in the sidebar.
pub fn pull_request_panel_rows(panel: &PullRequestPanel) -> usize {
    match panel {
        PullRequestPanel::Hidden => 0,
        PullRequestPanel::List(list) => list.len(),
        _ => 1,
    }
}

/// Branch name of a remote-tracking ref without its remote.
fn remote_branch_name(branch: &BranchRef) -> Option<&str> {
    branch.name.split_once('/').map(|(_, name)| name)
}

/// The name a ref's pull request head would have, local or remote.
fn head_branch_of(branch: &BranchRef) -> Option<&str> {
    if branch.remote {
        remote_branch_name(branch)
    } else {
        Some(&branch.name)
    }
}

/// The branch of this repository that holds a pull request's head.
///
/// A local branch of the same name wins, then `origin`, then any other remote. A fork's branch lives in another
/// repository, so it never matches by name.
pub fn pull_request_branch<'a>(
    pull_request: &PullRequest,
    branches: &'a [BranchRef],
) -> Option<&'a BranchRef> {
    if pull_request.from_fork {
        return None;
    }
    let head = pull_request.head_branch.as_str();
    let origin = format!("origin/{head}");
    branches
        .iter()
        .find(|branch| !branch.remote && branch.name == head)
        .or_else(|| {
            branches
                .iter()
                .find(|branch| branch.remote && branch.name == origin)
        })
        .or_else(|| {
            branches
                .iter()
                .find(|branch| branch.remote && remote_branch_name(branch) == Some(head))
        })
}

/// Finds the open pull requests for history rows. Built once per list of pull requests and branches.
#[derive(Debug, Default)]
pub struct PullRequestCommitIndex {
    pull_requests: Vec<PullRequest>,
    by_branch: HashMap<String, Vec<usize>>,
    by_sha: HashMap<String, Vec<usize>>,
    branches: Vec<BranchRef>,
    refs: RefIndex,
}

/// Matches pull requests to history rows. A row matches when one of its branch labels names a pull request's
/// head branch, local or remote, or when the row is the pull request's head commit. Fork pull requests match by
/// commit only.
pub fn pull_request_commit_index(
    pull_requests: &[PullRequest],
    branches: &[BranchRef],
) -> PullRequestCommitIndex {
    let mut by_branch: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_sha: HashMap<String, Vec<usize>> = HashMap::new();
    for (at, pr) in pull_requests.iter().enumerate() {
        if !pr.from_fork {
            by_branch
                .entry(pr.head_branch.clone())
                .or_default()
                .push(at);
        }
        if let Some(sha) = pr.head_sha.as_ref().filter(|sha| !sha.is_empty()) {
            by_sha.entry(sha.clone()).or_default().push(at);
        }
    }
    PullRequestCommitIndex {
        pull_requests: pull_requests.to_vec(),
        by_branch,
        by_sha,
        branches: branches.to_vec(),
        refs: RefIndex::new(branches),
    }
}

impl PullRequestCommitIndex {
    /// Matching pull requests for a row, newest first.
    pub fn for_commit(&self, commit: &Commit) -> Vec<&PullRequest> {
        let mut found: HashSet<usize> = self
            .by_sha
            .get(&commit.sha)
            .into_iter()
            .flatten()
            .copied()
            .collect();
        if !self.by_branch.is_empty() {
            for label in &commit.decorations {
                if label.starts_with("tag: ") {
                    continue;
                }
                let name = label.strip_prefix("HEAD -> ").unwrap_or(label);
                let Some(head) = self.refs.get(&self.branches, name).and_then(head_branch_of)
                else {
                    continue;
                };
                found.extend(self.by_branch.get(head).into_iter().flatten().copied());
            }
        }
        let mut matches: Vec<&PullRequest> = found
            .into_iter()
            .map(|at| &self.pull_requests[at])
            .collect();
        matches.sort_by(|a, b| newest_first(a, b));
        matches
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledSegment {
    pub text: String,
    pub color: Rgba,
}

fn segment(text: impl Into<String>, color: Rgba) -> StyledSegment {
    StyledSegment {
        text: text.into(),
        color,
    }
}

/// Fits segments to exactly `width` cells, clipping the last with an ellipsis.
pub fn fit_segments(segments: &[StyledSegment], width: usize, pad: Rgba) -> Vec<StyledSegment> {
    let total: usize = segments.iter().map(|s| string_width(&s.text)).sum();
    let clip = total > width;
    let room = if clip { width.saturating_sub(1) } else { width };
    let mut result = Vec::new();
    let mut used = 0;
    for part in segments {
        if used >= room {
            break;
        }
        let mut text = String::new();
        for character in part.text.chars() {
            let next = string_width(&character.to_string());
            if used + next > room {
                break;
            }
            text.push(character);
            used += next;
        }
        let clipped = text != part.text;
        if !text.is_empty() {
            result.push(segment(text, part.color));
        }
        if clipped {
            break;
        }
    }
    if clip && width > 0 {
        result.push(segment("…", pad));
        used += 1;
    }
    if used < width {
        result.push(segment(" ".repeat(width - used), pad));
    }
    result
}

/// One sidebar row: state, checks, number, an optional review marker, title.
pub fn pull_request_sidebar_row(
    pull_request: &PullRequest,
    width: usize,
    theme: &Theme,
    spinner_frame: &str,
) -> Vec<StyledSegment> {
    let (state, checks) = pull_request_icons(
        pull_request.state,
        pull_request.checks,
        theme,
        spinner_frame,
    );
    let review = pull_request.review_requested && !pull_request.mine;
    let mut parts = vec![
        segment(" ", theme.text),
        segment(state.glyph, state.color),
        segment(" ", theme.text),
        segment(checks.glyph, checks.color),
        segment(format!(" #{}", pull_request.number), theme.accent),
    ];
    if review {
        parts.push(segment(format!(" {PULL_REQUEST_REVIEW_ICON}"), theme.muted));
    }
    parts.push(segment(format!(" {}", pull_request.title), theme.text));
    fit_segments(&parts, width, theme.text)
}

/// The history PR cell: number tinted by state, the checks icon, and `+N` when more pull requests match the row.
/// Rows with no pull request get blank padding.
pub fn pull_request_history_cell(
    pull_requests: &[&PullRequest],
    width: usize,
    theme: &Theme,
    spinner_frame: &str,
) -> Vec<StyledSegment> {
    let Some(newest) = pull_requests.first() else {
        return fit_segments(&[], width, theme.muted);
    };
    let (state, checks) = pull_request_icons(newest.state, newest.checks, theme, spinner_frame);
    let mut parts = vec![
        segment(format!("#{}", newest.number), state.color),
        segment(format!(" {}", checks.glyph), checks.color),
    ];
    if pull_requests.len() > 1 {
        parts.push(segment(
            format!(" +{}", pull_requests.len() - 1),
            theme.muted,
        ));
    }
    fit_segments(&parts, width, theme.muted)
}

#[cfg(test)]
#[path = "pull_requests_tests.rs"]
mod tests;
