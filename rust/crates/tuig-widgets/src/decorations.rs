//! Ref labels for history rows. Ports the decoration part of `src/ui/history.ts`: `summariseDecorations`,
//! `formatBranchDecoration`, `branchPresence`, `primaryDecorationRef` and `resolveHeadSha`.
//!
//! Not ported yet: the branch hint search (`extendCommitBranchHints`), which labels a selected commit that has no
//! decoration with the nearest ref.

use std::collections::{HashMap, HashSet};
use tuig_git::types::{BranchRef, Commit};

pub const HEAD_ICON: &str = "◉";
pub const LAPTOP_BRANCH_ICON: &str = "󰌢";
pub const REMOTE_BRANCH_ICON: &str = "󰖟";
pub const TAG_ICON: &str = "";

/// The commit HEAD points at: the current branch, or a bare `HEAD` decoration when detached.
pub fn resolve_head_sha(branches: &[BranchRef], commits: &[Commit]) -> Option<String> {
    if let Some(current) = branches.iter().find(|branch| branch.current) {
        return Some(current.sha.clone());
    }
    commits
        .iter()
        .find(|commit| {
            commit
                .decorations
                .iter()
                .any(|label| label == "HEAD" || label.starts_with("HEAD -> "))
        })
        .map(|commit| commit.sha.clone())
}

fn strip<'a>(name: &'a str, prefix: &str) -> &'a str {
    name.strip_prefix(prefix).unwrap_or(name)
}

pub fn display_branch_name(name: &str) -> &str {
    strip(
        strip(strip(name, "refs/heads/"), "refs/remotes/"),
        "origin/",
    )
}

fn strip_ref_prefixes(name: &str) -> &str {
    strip(strip(name, "refs/heads/"), "refs/remotes/")
}

/// Lookup tables built once per ref list, for decorations and branch presence.
#[derive(Debug, Default)]
pub struct RefIndex {
    /// Decoration alias to the index of its ref. The first ref wins, as `Array#find` does.
    aliases: HashMap<String, usize>,
    local_names: HashSet<String>,
    remote_names: HashSet<String>,
    remote_name_suffixes: HashSet<String>,
    remote_prefixes: HashSet<String>,
}

impl RefIndex {
    pub fn new(refs: &[BranchRef]) -> Self {
        let mut index = Self::default();
        for (position, branch) in refs.iter().enumerate() {
            let mut aliases = vec![branch.name.as_str(), branch.full_name.as_str()];
            for prefix in ["refs/heads/", "refs/remotes/"] {
                if let Some(short) = branch.full_name.strip_prefix(prefix) {
                    aliases.push(short);
                }
            }
            for alias in aliases {
                index.aliases.entry(alias.to_string()).or_insert(position);
            }
            if !branch.remote {
                index.local_names.insert(branch.name.clone());
                index.local_names.insert(branch.full_name.clone());
                if let Some(short) = branch.full_name.strip_prefix("refs/heads/") {
                    index.local_names.insert(short.to_string());
                }
                continue;
            }
            let remote_name = strip_ref_prefixes(&branch.name);
            index.remote_names.insert(remote_name.to_string());
            for (slash, _) in remote_name.match_indices('/') {
                index
                    .remote_name_suffixes
                    .insert(remote_name[slash + 1..].to_string());
            }
            if let Some(separator) = remote_name.find('/').filter(|&at| at > 0) {
                index
                    .remote_prefixes
                    .insert(remote_name[..separator].to_string());
            }
        }
        index
    }

    /// The ref a decoration alias names. The first ref with that alias wins.
    pub fn get<'r>(&self, refs: &'r [BranchRef], alias: &str) -> Option<&'r BranchRef> {
        self.aliases.get(alias).and_then(|&at| refs.get(at))
    }

    /// Whether a ref exists locally, remotely, or both. Ports `branchPresenceFromIndex` for a `BranchRef`.
    fn presence(&self, branch: &BranchRef) -> (bool, bool) {
        let normalised = strip_ref_prefixes(&branch.name);
        let separator = normalised.find('/').filter(|&at| at > 0);
        let names: Vec<&str> = match separator {
            Some(at) if branch.remote => vec![normalised, &normalised[at + 1..]],
            _ => vec![normalised],
        };
        let local = names.iter().any(|name| self.local_names.contains(*name));
        let remote = names.iter().any(|name| {
            self.remote_names.contains(*name) || self.remote_name_suffixes.contains(*name)
        });
        (local, remote)
    }
}

/// Ports `formatBranchDecoration`.
pub fn format_branch_decoration(label: &str, refs: &[BranchRef], index: &RefIndex) -> String {
    if label == "refs/stash" || label == "stash" {
        return "stash".to_string();
    }
    let head = label.starts_with("HEAD -> ") || label == "HEAD";
    let name = strip(label, "HEAD -> ");
    let display = display_branch_name(name);
    let Some(branch) = index.get(refs, name) else {
        return if head {
            format!("{HEAD_ICON} {display}")
        } else {
            display.to_string()
        };
    };
    let (local, remote) = index.presence(branch);
    let local_icon = if head { HEAD_ICON } else { LAPTOP_BRANCH_ICON };
    let icons = if local && remote {
        format!("{local_icon} {REMOTE_BRANCH_ICON}")
    } else if branch.remote {
        REMOTE_BRANCH_ICON.to_string()
    } else {
        local_icon.to_string()
    };
    format!("{icons} {display}")
}

/// Branch decorations in display order: the `HEAD -> ` one first.
fn ordered_branches(decorations: &[String]) -> Vec<&str> {
    let branches: Vec<&str> = decorations
        .iter()
        .map(String::as_str)
        .filter(|label| !label.starts_with("tag: "))
        .collect();
    let head = branches
        .iter()
        .copied()
        .find(|label| label.starts_with("HEAD -> "));
    head.into_iter()
        .chain(branches.into_iter().filter(|label| Some(*label) != head))
        .collect()
}

/// The one label a row shows and how many other refs it hides. Ports `summariseDecorations`.
pub fn summarise_decorations(
    decorations: &[String],
    refs: &[BranchRef],
    index: &RefIndex,
) -> (String, usize) {
    let mut tags: Vec<&str> = Vec::new();
    for tag in decorations
        .iter()
        .filter_map(|label| label.strip_prefix("tag: "))
    {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    let ordered = ordered_branches(decorations);
    let distinct: HashSet<&str> = ordered
        .iter()
        .map(|label| display_branch_name(strip(label, "HEAD -> ")))
        .collect();
    let total = distinct.len() + tags.len();
    if total == 0 {
        return (String::new(), 0);
    }
    let label = match ordered.first() {
        Some(first) => format_branch_decoration(first, refs, index),
        None => format!("{TAG_ICON} {}", tags[0]),
    };
    (label, total - 1)
}

/// The ref behind the label a row shows. Ports `primaryDecorationRef`.
pub fn primary_decoration_ref<'r>(
    decorations: &[String],
    refs: &'r [BranchRef],
    index: &RefIndex,
) -> Option<&'r BranchRef> {
    let first = *ordered_branches(decorations).first()?;
    let name = strip(first, "HEAD -> ");
    if name == "HEAD" || name == "refs/stash" || name == "stash" {
        return None;
    }
    index.get(refs, name)
}
