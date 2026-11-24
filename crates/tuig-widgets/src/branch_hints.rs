//! Branch context for commits that are ancestors of a branch tip rather than tips themselves. Ports
//! `extendCommitBranchHints` in `src/ui/history.ts`.
//!
//! A selected history row without a ref label shows `↳ <icon> <branch>` for the nearest ref that reaches it. The
//! search starts at every ref tip and walks parents, fewest hops first. Ties go to the current branch, then a local
//! branch, then a remote one, then the earlier ref. History loads a page at a time, so the search keeps its state
//! and resumes when the next page arrives. A commit's hint is provisional: a later page can reveal a nearer tip.

use crate::decorations::{LAPTOP_BRANCH_ICON, REMOTE_BRANCH_ICON, display_branch_name};
use std::collections::{BTreeMap, HashMap};
use tuig_git::types::{BranchRef, Commit};

#[derive(Debug, Clone, Copy)]
struct Candidate {
    hops: usize,
    /// Current branch 0, local 1, remote 2.
    priority: u8,
    /// Position of the ref in the ref list.
    order: usize,
}

/// Nearest wins, then the more important ref, then the earlier ref.
fn better(a: &Candidate, b: Option<&Candidate>) -> bool {
    let Some(b) = b else {
        return true;
    };
    (a.hops, a.priority, a.order) < (b.hops, b.priority, b.order)
}

/// The ref set a search was seeded from, so a changed set restarts it.
fn seed_of(refs: &[BranchRef]) -> String {
    refs.iter()
        .map(|branch| {
            format!(
                "{}\0{}\0{}{}",
                branch.name,
                branch.sha,
                u8::from(branch.current),
                u8::from(branch.remote)
            )
        })
        .collect::<Vec<_>>()
        .join("\u{1}")
}

/// The resumable search state and its results.
#[derive(Debug, Default)]
pub struct BranchHintIndex {
    /// Parents by SHA, for every commit loaded so far.
    parents: HashMap<String, Vec<String>>,
    /// Best known candidate per SHA.
    best: HashMap<String, Candidate>,
    /// Candidates waiting to be expanded, by hop count.
    pending: BTreeMap<usize, HashMap<String, Candidate>>,
    /// Candidates whose commit is not loaded yet.
    deferred: HashMap<String, Candidate>,
    /// The hint text of each labelled commit.
    hints: HashMap<String, String>,
    seed: Option<String>,
}

impl BranchHintIndex {
    /// The hint for `sha`, such as `↳ 󰌢 main`. `None` when no loaded ref reaches the commit.
    pub fn hint(&self, sha: &str) -> Option<&str> {
        self.hints.get(sha).map(String::as_str)
    }

    fn consider(&mut self, sha: &str, candidate: Candidate) {
        if !better(&candidate, self.best.get(sha)) {
            return;
        }
        let level = self.pending.entry(candidate.hops).or_default();
        if better(&candidate, level.get(sha)) {
            level.insert(sha.to_owned(), candidate);
        }
    }

    /// Folds `commits` (a page, or all of them for a new history) into the search. A changed ref set starts the
    /// search again from the refs and keeps the parents loaded so far.
    pub fn extend(&mut self, commits: &[Commit], refs: &[BranchRef]) {
        let seed = seed_of(refs);
        let restarted = self.seed.as_deref() != Some(seed.as_str());
        if restarted {
            let parents = std::mem::take(&mut self.parents);
            *self = Self {
                parents,
                ..Self::default()
            };
        }
        self.seed = Some(seed);
        for commit in commits {
            self.parents
                .insert(commit.sha.clone(), commit.parents.clone());
        }
        if restarted {
            for (order, branch) in refs.iter().enumerate() {
                let priority = if branch.current {
                    0
                } else if branch.remote {
                    2
                } else {
                    1
                };
                self.consider(
                    &branch.sha,
                    Candidate {
                        hops: 0,
                        priority,
                        order,
                    },
                );
            }
        }
        // A commit that was missing may be in this page. Resume at its parents.
        let held: Vec<(String, Candidate)> = self
            .deferred
            .iter()
            .filter(|(sha, _)| self.parents.contains_key(*sha))
            .map(|(sha, candidate)| (sha.clone(), *candidate))
            .collect();
        for (sha, candidate) in held {
            self.deferred.remove(&sha);
            let parents = self.parents.get(&sha).cloned().unwrap_or_default();
            for parent in parents {
                self.consider(
                    &parent,
                    Candidate {
                        hops: candidate.hops + 1,
                        ..candidate
                    },
                );
            }
        }
        // Fewest hops first, so a commit is normally settled once.
        while let Some((hops, level)) = self.pending.pop_first() {
            for (sha, candidate) in level {
                if !better(&candidate, self.best.get(&sha)) {
                    continue;
                }
                self.best.insert(sha.clone(), candidate);
                if let Some(branch) = refs.get(candidate.order) {
                    self.hints.insert(sha.clone(), hint_for(branch));
                }
                let Some(parents) = self.parents.get(&sha).cloned() else {
                    self.deferred.insert(sha, candidate);
                    continue;
                };
                for parent in parents {
                    self.consider(
                        &parent,
                        Candidate {
                            hops: hops + 1,
                            ..candidate
                        },
                    );
                }
            }
        }
    }
}

fn hint_for(branch: &BranchRef) -> String {
    let icon = if branch.remote {
        REMOTE_BRANCH_ICON
    } else {
        LAPTOP_BRANCH_ICON
    };
    format!("↳ {icon} {}", display_branch_name(&branch.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(sha: &str, parents: &[&str]) -> Commit {
        Commit {
            sha: sha.into(),
            parents: parents.iter().map(|parent| (*parent).into()).collect(),
            ..Commit::default()
        }
    }

    fn branch(name: &str, sha: &str, current: bool, remote: bool) -> BranchRef {
        BranchRef {
            name: name.into(),
            full_name: name.into(),
            sha: sha.into(),
            current,
            remote,
            upstream: None,
            tracking: None,
        }
    }

    /// `main` at c, a at b, merged history c -> b -> a -> root.
    fn chain() -> Vec<Commit> {
        vec![
            commit("c", &["b"]),
            commit("b", &["a"]),
            commit("a", &["root"]),
            commit("root", &[]),
        ]
    }

    fn all_hints(index: &BranchHintIndex, commits: &[Commit]) -> Vec<Option<String>> {
        commits
            .iter()
            .map(|commit| index.hint(&commit.sha).map(str::to_owned))
            .collect()
    }

    #[test]
    fn an_ancestor_takes_the_nearest_ref_then_the_current_branch() {
        let commits = chain();
        let refs = [
            branch("release", "b", false, false),
            branch("main", "c", true, false),
            branch("origin/main", "c", false, true),
        ];
        let mut index = BranchHintIndex::default();
        index.extend(&commits, &refs);
        let hint = |name: &str, icon: &str| Some(format!("↳ {icon} {name}"));
        assert_eq!(
            all_hints(&index, &commits),
            [
                // Two refs tie at the tip: the current branch beats the remote.
                hint("main", LAPTOP_BRANCH_ICON),
                // `release` is on the commit itself, `main` is one hop away.
                hint("release", LAPTOP_BRANCH_ICON),
                // Both reach `a`: `release` in one hop, `main` in two.
                hint("release", LAPTOP_BRANCH_ICON),
                hint("release", LAPTOP_BRANCH_ICON),
            ]
        );
    }

    #[test]
    fn a_remote_ref_shows_its_icon_without_the_remote_name() {
        let commits = chain();
        let mut index = BranchHintIndex::default();
        index.extend(&commits, &[branch("origin/feature", "c", false, true)]);
        assert_eq!(
            index.hint("a"),
            Some(format!("↳ {REMOTE_BRANCH_ICON} feature").as_str())
        );
    }

    #[test]
    fn paging_resumes_the_search_and_matches_one_pass_over_the_whole_history() {
        let commits = chain();
        let refs = [
            branch("main", "c", true, false),
            // The tip of `old` is on the second page, nearer to `root` than `main` is.
            branch("old", "a", false, false),
        ];
        let mut whole = BranchHintIndex::default();
        whole.extend(&commits, &refs);

        let mut paged = BranchHintIndex::default();
        paged.extend(&commits[..2], &refs);
        // The tip of `old` is labelled before its commit loads, and its ancestors wait for the page.
        assert!(paged.hint("a").unwrap().ends_with("old"));
        assert_eq!(paged.hint("root"), None);
        paged.extend(&commits[2..], &refs);
        assert_eq!(all_hints(&paged, &commits), all_hints(&whole, &commits));
        assert!(paged.hint("root").unwrap().ends_with("old"));
    }

    #[test]
    fn a_changed_ref_set_starts_again_but_keeps_the_loaded_commits() {
        let commits = chain();
        let mut index = BranchHintIndex::default();
        index.extend(&commits, &[branch("main", "c", true, false)]);
        assert!(index.hint("root").unwrap().ends_with("main"));
        // A checkout moved the tip. The loaded commits are not passed again.
        index.extend(&[], &[branch("main", "b", true, false)]);
        assert_eq!(index.hint("c"), None);
        assert!(index.hint("root").unwrap().ends_with("main"));
    }
}
