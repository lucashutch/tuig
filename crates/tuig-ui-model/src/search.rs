//! Search result state and rows. Ports the pure part of `src/ui/search.ts`.
//!
//! Difference from TypeScript: [`search_graph_rows`] takes the dot color from
//! the caller. TypeScript reads it from the active theme, which does not live
//! in this module.

use tuig_git::repository::DEFAULT_HISTORY_PAGE;
use tuig_git::types::Commit;

use crate::graph::{GraphCell, GraphRow};

/// Delay between the last keystroke and the search running.
pub const SEARCH_DEBOUNCE_MS: u64 = 180;

/// Result records read per page as the reader scrolls the matches.
pub const SEARCH_PAGE: usize = DEFAULT_HISTORY_PAGE;

/// Results paged into the history pane while a query is showing.
#[derive(Debug, Clone, Default)]
pub struct SearchResults {
    pub query: String,
    /// Every matching commit in the repository, newest first.
    pub shas: Vec<String>,
    /// Records read so far, a prefix of `shas`.
    pub commits: Vec<Commit>,
    pub rows: Vec<GraphRow>,
}

/// Rows for a list of search results.
///
/// Matches come from anywhere in history, so no ancestry joins them. Each
/// result gets one dot in lane 0.
pub fn search_graph_rows(commits: &[Commit], head_sha: Option<&str>, color: &str) -> Vec<GraphRow> {
    commits
        .iter()
        .map(|commit| {
            let head = head_sha == Some(commit.sha.as_str());
            GraphRow {
                sha: commit.sha.clone(),
                lane: 0,
                head,
                continues_above: false,
                cells: vec![GraphCell {
                    symbol: if head { "◉ " } else { "● " }.to_string(),
                    color: color.to_string(),
                }],
                connectors: Vec::new(),
            }
        })
        .collect()
}
