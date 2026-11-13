//! Pure parsers for Git's machine-readable output. Port of `src/git/parsers.ts`.
//!
//! The TypeScript string pooling and `detach` helpers have no counterpart
//! here. Rust strings own their bytes, so a parsed field never pins its source.

use std::collections::HashMap;

use crate::types::{
    BranchRef, ChangedFile, Commit, FileState, Stash, Submodule, SubmoduleState, Worktree,
};

/// `value.slice(count)` on characters. Out-of-range counts give an empty string.
fn skip_chars(value: &str, count: usize) -> String {
    value.chars().skip(count).collect()
}

/// Field `index` of a split, or "" like `f[index] ?? ""`.
fn field<'a>(fields: &[&'a str], index: usize) -> &'a str {
    fields.get(index).copied().unwrap_or("")
}

/// Parses `git status --porcelain=v2 -z`.
pub fn parse_status(data: &str) -> Vec<ChangedFile> {
    let mut out = Vec::new();
    let parts: Vec<&str> = data.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let r = parts[i];
        i += 1;
        if r.is_empty() || r == "#" {
            continue;
        }
        let ordinary = r.starts_with("1 ");
        let renamed = r.starts_with("2 ");
        let unmerged = r.starts_with("u ");
        if ordinary || renamed || unmerged {
            let xy = r.split(' ').nth(1).unwrap_or("  ");
            let path = after_spaces(
                r,
                if unmerged {
                    10
                } else if renamed {
                    9
                } else {
                    8
                },
            );
            let original = if renamed {
                let original = parts.get(i).map(|p| p.to_string());
                i += 1;
                original
            } else {
                None
            };
            let mut xy_chars = xy.chars();
            out.push(ChangedFile {
                path,
                original_path: original,
                state: if unmerged {
                    FileState::Conflicted
                } else {
                    state_for(xy)
                },
                staged: xy_chars.next() != Some('.'),
                unstaged: xy_chars.next() != Some('.'),
                submodule: None,
            });
        } else if let Some(path) = r.strip_prefix("? ") {
            out.push(ChangedFile {
                path: path.to_string(),
                original_path: None,
                state: FileState::Untracked,
                staged: false,
                unstaged: true,
                submodule: None,
            });
        }
    }
    out
}

/// Text after the `count`-th space. Repeats `indexOf(" ", at + 1)` exactly, so
/// a missing space restarts the search at 0 like the TypeScript loop does.
fn after_spaces(value: &str, count: usize) -> String {
    let mut at: Option<usize> = None;
    for _ in 0..count {
        let start = at.map_or(0, |a| a + 1);
        at = value
            .get(start..)
            .and_then(|rest| rest.find(' '))
            .map(|found| found + start);
    }
    match at {
        Some(at) => value[at + 1..].to_string(),
        None => String::new(),
    }
}

fn state_for(xy: &str) -> FileState {
    // `replace(".", "")` removes only the first dot.
    let mut x = xy.to_string();
    if let Some(dot) = x.find('.') {
        x.remove(dot);
    }
    if x.contains('U') {
        return FileState::Conflicted;
    }
    match x.chars().next() {
        Some('A') => FileState::Added,
        Some('D') => FileState::Deleted,
        Some('R') => FileState::Renamed,
        Some('C') => FileState::Copied,
        _ => FileState::Modified,
    }
}

/// Parses `git for-each-ref` output with `\0` record terminators.
pub fn parse_refs(data: &str) -> Vec<BranchRef> {
    data.split('\0')
        .filter(|r| !r.is_empty())
        .map(|r| {
            let record = r.trim_start_matches('\n');
            let f: Vec<&str> = record.split('\t').collect();
            let full_name = field(&f, 0);
            let name = full_name
                .strip_prefix("refs/heads/")
                .or_else(|| full_name.strip_prefix("refs/remotes/"))
                .unwrap_or(full_name);
            BranchRef {
                name: name.to_string(),
                full_name: full_name.to_string(),
                sha: field(&f, 1).to_string(),
                current: f.get(2) == Some(&"*"),
                remote: full_name.starts_with("refs/remotes/"),
                upstream: None,
                tracking: None,
            }
        })
        .collect()
}

/// Parses structured `git log` output. Records end in `\x1e`, or in `\0` for
/// older callers. Fields are separated by `\x1f`.
pub fn parse_log(data: &str) -> Vec<Commit> {
    let records: Vec<&str> = if data.contains('\x1e') {
        data.split(['\x1e', '\0']).collect()
    } else {
        data.split('\0').collect()
    };
    records
        .into_iter()
        .filter(|x| !x.is_empty())
        .map(|x| {
            let f: Vec<&str> = x.trim_start_matches('\n').split('\x1f').collect();
            let parents = field(&f, 1)
                .split(' ')
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect();
            let decorations = field(&f, 9)
                .split(", ")
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .collect();
            let body = f.get(10..).unwrap_or_default().join("\x1f");
            Commit {
                sha: field(&f, 0).to_string(),
                parents,
                author: field(&f, 2).to_string(),
                author_email: field(&f, 3).to_string(),
                authored_at: field(&f, 4).to_string(),
                committer: field(&f, 5).to_string(),
                committer_email: field(&f, 6).to_string(),
                committed_at: field(&f, 7).to_string(),
                subject: field(&f, 8).to_string(),
                decorations,
                body: Some(body.trim_matches('\n').to_string()),
            }
        })
        .collect()
}

pub use parse_log as parse_structured_log;
pub use parse_refs as parse_for_each_ref;
pub use parse_status as parse_porcelain_status;

/// Parses `git stash list` output with a tab-separated `ref sha date subject` format.
pub fn parse_stashes(data: &str) -> Vec<Stash> {
    // `stash list` appends the requested NUL terminator to its normal newline
    // record separator, so records are commonly separated by `\0\n`.
    data.split(['\0', '\n'])
        .filter(|x| !x.is_empty())
        .map(|x| {
            // Subjects are free-form and may themselves contain tabs. Only the
            // first three separators belong to the machine-readable fields.
            let mut fields: Vec<&str> = Vec::new();
            let mut rest = x;
            for _ in 0..3 {
                let Some(separator) = rest.find('\t') else {
                    break;
                };
                fields.push(&rest[..separator]);
                rest = &rest[separator + 1..];
            }
            Stash {
                reference: field(&fields, 0).to_string(),
                sha: field(&fields, 1).to_string(),
                created_at: field(&fields, 2).to_string(),
                subject: rest.to_string(),
                branch: stash_branch(rest),
            }
        })
        .collect()
}

/// Subjects look like "WIP on <branch>: ..." or "On <branch>: ...".
fn stash_branch(subject: &str) -> Option<String> {
    let rest = subject
        .strip_prefix("WIP on ")
        .or_else(|| subject.strip_prefix("On "))?;
    let colon = rest.find(':')?;
    let branch = rest[..colon].trim();
    (colon > 0 && !branch.is_empty()).then(|| branch.to_string())
}

/// Parses `git diff --name-status -z`.
pub fn parse_name_status(data: &str) -> Vec<ChangedFile> {
    let parts: Vec<&str> = data.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let status = parts[i];
        i += 1;
        if status.is_empty() {
            continue;
        }
        let code = status.chars().next().unwrap_or('M');
        let first = parts.get(i).copied().unwrap_or("");
        i += 1;
        let renamed = code == 'R' || code == 'C';
        let path = if renamed {
            let second = parts.get(i).copied().unwrap_or(first);
            i += 1;
            second
        } else {
            first
        };
        files.push(ChangedFile {
            path: path.to_string(),
            original_path: renamed.then(|| first.to_string()),
            state: match code {
                'A' => FileState::Added,
                'D' => FileState::Deleted,
                'R' => FileState::Renamed,
                'C' => FileState::Copied,
                _ => FileState::Modified,
            },
            staged: false,
            unstaged: false,
            submodule: None,
        });
    }
    files
}

/// Parses `git worktree list --porcelain`.
pub fn parse_worktrees(s: &str) -> Vec<Worktree> {
    s.split("\n\n")
        .filter(|x| !x.is_empty())
        .map(|x| {
            let lines: Vec<&str> = x.split('\n').collect();
            let find = |prefix: &str, skip: usize| {
                lines
                    .iter()
                    .find(|l| l.starts_with(prefix))
                    .map(|l| skip_chars(l, skip))
            };
            Worktree {
                path: find("worktree ", 9).unwrap_or_default(),
                sha: find("HEAD ", 5).unwrap_or_default(),
                branch: find("branch ", 7)
                    .map(|b| b.strip_prefix("refs/heads/").unwrap_or(&b).to_string()),
                bare: lines.contains(&"bare"),
                detached: lines.contains(&"detached"),
                locked: find("locked", 7),
                prunable: find("prunable", 9),
            }
        })
        .collect()
}

/// Parses NUL-delimited `git config --null --get-regexp` submodule paths into a path-to-name map.
pub fn parse_submodule_names(s: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for entry in s.split('\0') {
        let Some(newline) = entry.find('\n') else {
            continue;
        };
        let key = &entry[..newline];
        let path = &entry[newline + 1..];
        let name = key
            .strip_prefix("submodule.")
            .and_then(|k| k.strip_suffix(".path"))
            .filter(|n| !n.is_empty());
        if let Some(name) = name
            && !path.is_empty()
        {
            names.insert(path.to_string(), name.to_string());
        }
    }
    names
}

/// Parses `git submodule status`. `names` maps paths to `.gitmodules` names.
pub fn parse_submodules(s: &str, names: Option<&HashMap<String, String>>) -> Vec<Submodule> {
    s.split('\n')
        .filter(|x| !x.is_empty())
        .map(|x| {
            let rest = skip_chars(x, 42);
            let rest = rest.trim();
            let (path, description) = split_description(rest);
            let sha: String = x.chars().skip(1).take(40).collect();
            Submodule {
                name: names.and_then(|n| n.get(path)).cloned(),
                sha,
                path: path.to_string(),
                description: description.map(str::to_string),
                state: match x.chars().next() {
                    Some('-') => SubmoduleState::Uninitialized,
                    Some('+') => SubmoduleState::Different,
                    Some('U') => SubmoduleState::Conflicted,
                    _ => SubmoduleState::Clean,
                },
            }
        })
        .collect()
}

/// Equivalent of `/^(.*?)(?: \((.*)\))?$/`: the path ends at the first " (" whose
/// description runs to a closing parenthesis at the end of the text.
fn split_description(rest: &str) -> (&str, Option<&str>) {
    if rest.ends_with(')') {
        let mut from = 0;
        while let Some(found) = rest[from..].find(" (") {
            let start = from + found;
            if start + 3 <= rest.len() {
                return (&rest[..start], Some(&rest[start + 2..rest.len() - 1]));
            }
            from = start + 1;
        }
    }
    (rest, None)
}

/// Upstream and ahead/behind counts from `git status --porcelain=v2 --branch -z`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Tracking {
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

pub fn parse_tracking(s: &str) -> Tracking {
    let records: Vec<&str> = s.split('\0').collect();
    let upstream = records
        .iter()
        .find(|x| x.starts_with("# branch.upstream "))
        .map(|x| skip_chars(x, 18));
    let (ahead, behind) = records
        .iter()
        .find(|x| x.starts_with("# branch.ab "))
        .and_then(|x| find_ahead_behind(x))
        .unwrap_or((0, 0));
    Tracking {
        upstream,
        ahead,
        behind,
    }
}

/// Equivalent of `/\+(\d+) -(\d+)/`, first match.
fn find_ahead_behind(record: &str) -> Option<(usize, usize)> {
    let bytes = record.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    for (plus, _) in record.match_indices('+') {
        let a_len = digits(plus + 1);
        let sep = plus + 1 + a_len;
        if a_len == 0 || !record[sep..].starts_with(" -") {
            continue;
        }
        let b_start = sep + 2;
        let b_len = digits(b_start);
        if b_len == 0 {
            continue;
        }
        let parse = |range: std::ops::Range<usize>| record[range].parse().unwrap_or(usize::MAX);
        return Some((parse(plus + 1..sep), parse(b_start..b_start + b_len)));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "1234567890123456789012345678901234567890";

    #[test]
    fn parses_distinct_author_and_committer_fields_without_splitting_message_fields() {
        let log = "sha\x1fparent\x1fAuthor\x1fauthor@example.com\x1f2020-01-01T00:00:00+00:00\x1fCommitter\x1fcommitter@example.com\x1f2020-01-02T00:00:00+00:00\x1fsubject\x1fHEAD -> main\x1fbody\x1fwith separator\x1e";
        let commit = &parse_log(log)[0];
        assert_eq!(commit.author, "Author");
        assert_eq!(commit.committer, "Committer");
        assert_eq!(commit.committer_email, "committer@example.com");
        assert_eq!(commit.committed_at, "2020-01-02T00:00:00+00:00");
        assert_eq!(commit.subject, "subject");
        assert_eq!(commit.parents, ["parent"]);
        assert_eq!(commit.decorations, ["HEAD -> main"]);
        assert_eq!(commit.body.as_deref(), Some("body\x1fwith separator"));
    }

    #[test]
    fn log_accepts_nul_records_and_trims_body_newlines() {
        let record = |sha: &str| {
            format!(
                "\n{sha}\x1fp1 p2\x1fA\x1fa@b\x1fd1\x1fA\x1fa@b\x1fd2\x1fsubj\x1f\x1f\n\nbody\n\n"
            )
        };
        let commits = parse_log(&format!("{}\0{}", record("a"), record("b")));
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[1].sha, "b");
        assert_eq!(commits[0].parents, ["p1", "p2"]);
        assert!(commits[0].decorations.is_empty());
        assert_eq!(commits[0].body.as_deref(), Some("body"));
    }

    #[test]
    fn keeps_spaces_in_ordinary_and_unmerged_paths() {
        let ordinary = "1 .M N... 100644 100644 100644 abcdef0 abcdef0 path with spaces.txt\0";
        let unmerged =
            "u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict name.txt\0";
        assert_eq!(parse_status(ordinary)[0].path, "path with spaces.txt");
        assert_eq!(parse_status(unmerged)[0].path, "conflict name.txt");
        assert_eq!(parse_status(unmerged)[0].state, FileState::Conflicted);
    }

    #[test]
    fn status_reads_renames_untracked_files_and_staging_flags() {
        let data = "# branch.oid abc\0# branch.head main\0\
            2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 new name.txt\0old name.txt\0\
            1 AM N... 000000 100644 100644 0000000 bbbbbbb added.txt\0\
            1 .D N... 100644 100644 000000 aaaaaaa aaaaaaa gone.txt\0\
            ? untracked file.txt\0";
        let files = parse_status(data);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].state, FileState::Renamed);
        assert_eq!(files[0].path, "new name.txt");
        assert_eq!(files[0].original_path.as_deref(), Some("old name.txt"));
        assert!(files[0].staged && !files[0].unstaged);
        assert_eq!(files[1].state, FileState::Added);
        assert!(files[1].staged && files[1].unstaged);
        assert_eq!(files[2].state, FileState::Deleted);
        assert!(!files[2].staged && files[2].unstaged);
        assert_eq!(files[3].state, FileState::Untracked);
        assert_eq!(files[3].path, "untracked file.txt");
    }

    #[test]
    fn keeps_tabs_in_stash_subjects() {
        assert_eq!(
            parse_stashes("stash@{0}\tabc\t2 hours ago\tfix\twith tab\0"),
            [Stash {
                reference: "stash@{0}".into(),
                sha: "abc".into(),
                created_at: "2 hours ago".into(),
                subject: "fix\twith tab".into(),
                branch: None,
            }]
        );
    }

    #[test]
    fn parses_multiple_stash_records_separated_by_nul_and_newline() {
        let stashes = parse_stashes(
            "stash@{0}\tabc\t2 hours ago\tfirst\0\nstash@{1}\tdef\tyesterday\tsecond\0\n",
        );
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].subject, "first");
        assert_eq!(stashes[1].reference, "stash@{1}");
        assert_eq!(stashes[1].created_at, "yesterday");
        assert_eq!(stashes[1].subject, "second");
    }

    #[test]
    fn extracts_the_branch_from_stash_subjects() {
        let branch = |data: &str| parse_stashes(data)[0].branch.clone();
        assert_eq!(
            branch("stash@{0}\tabc\t9 minutes ago\tWIP on fix/avatar-flicker: b97d195 fix thing\0"),
            Some("fix/avatar-flicker".into())
        );
        assert_eq!(
            branch("stash@{0}\tabc\tnow\tOn main: custom message\0"),
            Some("main".into())
        );
        assert_eq!(branch("stash@{0}\tabc\tnow\tcustom message\0"), None);
    }

    #[test]
    fn parses_full_worktree_sha_and_normalizes_branch() {
        let worktrees = parse_worktrees(&format!(
            "worktree /repo\nHEAD {SHA}\nbranch refs/heads/main\n\n"
        ));
        assert_eq!(worktrees[0].path, "/repo");
        assert_eq!(worktrees[0].sha, SHA);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn worktree_flags_and_lock_reasons() {
        let worktrees = parse_worktrees(&format!(
            "worktree /a\nHEAD {SHA}\nbare\n\nworktree /b\nHEAD {SHA}\ndetached\nlocked\nprunable gitdir file points to non-existent location\n\nworktree /c\nHEAD {SHA}\nlocked on a trip\n"
        ));
        assert!(worktrees[0].bare && worktrees[0].branch.is_none());
        assert!(worktrees[1].detached);
        assert_eq!(worktrees[1].locked.as_deref(), Some(""));
        assert_eq!(
            worktrees[1].prunable.as_deref(),
            Some("gitdir file points to non-existent location")
        );
        assert_eq!(worktrees[2].locked.as_deref(), Some("on a trip"));
    }

    #[test]
    fn separates_submodule_path_and_description() {
        let parsed = parse_submodules(&format!(" {SHA} libs/my lib (heads/main)\n"), None);
        assert_eq!(parsed[0].path, "libs/my lib");
        assert_eq!(parsed[0].description.as_deref(), Some("heads/main"));
        assert_eq!(parsed[0].state, SubmoduleState::Clean);
    }

    #[test]
    fn submodule_state_comes_from_the_status_prefix() {
        let states: Vec<_> = ["-", "+", "U", " "]
            .iter()
            .map(|p| parse_submodules(&format!("{p}{SHA} path\n"), None)[0].state)
            .collect();
        assert_eq!(
            states,
            [
                SubmoduleState::Uninitialized,
                SubmoduleState::Different,
                SubmoduleState::Conflicted,
                SubmoduleState::Clean
            ]
        );
    }

    #[test]
    fn maps_nul_delimited_gitmodules_paths_to_config_names() {
        let names = parse_submodule_names(
            "submodule.library.path\nlibs/my library\0submodule.deep.module.path\nmodules/nested path\0",
        );
        let parsed = parse_submodules(&format!(" {SHA} modules/nested path\n"), Some(&names));
        assert_eq!(parsed[0].path, "modules/nested path");
        assert_eq!(parsed[0].name.as_deref(), Some("deep.module"));
        assert_eq!(
            names.get("libs/my library").map(String::as_str),
            Some("library")
        );
    }

    #[test]
    fn parses_multiple_local_and_remote_refs_and_marks_the_current_branch() {
        let refs = parse_refs(&format!(
            "refs/heads/main\t{SHA}\t*\0\nrefs/heads/feature/x\t{SHA}\t\0refs/remotes/origin/main\t{SHA}\t\0"
        ));
        let summary: Vec<_> = refs
            .iter()
            .map(|r| (r.name.as_str(), r.full_name.as_str(), r.current, r.remote))
            .collect();
        assert_eq!(
            summary,
            [
                ("main", "refs/heads/main", true, false),
                ("feature/x", "refs/heads/feature/x", false, false),
                ("origin/main", "refs/remotes/origin/main", false, true),
            ]
        );
        assert_eq!(refs[0].sha, SHA);
    }

    #[test]
    fn name_status_reads_renames_and_copies_as_two_paths() {
        let files = parse_name_status(
            "M\0a.txt\0A\0b.txt\0D\0c.txt\0R100\0old.txt\0new.txt\0C75\0src\0dst\0",
        );
        let summary: Vec<_> = files
            .iter()
            .map(|f| (f.state, f.path.as_str(), f.original_path.as_deref()))
            .collect();
        assert_eq!(
            summary,
            [
                (FileState::Modified, "a.txt", None),
                (FileState::Added, "b.txt", None),
                (FileState::Deleted, "c.txt", None),
                (FileState::Renamed, "new.txt", Some("old.txt")),
                (FileState::Copied, "dst", Some("src")),
            ]
        );
    }

    #[test]
    fn tracking_reads_upstream_and_counts() {
        let tracking =
            parse_tracking("# branch.oid abc\0# branch.upstream origin/main\0# branch.ab +3 -12\0");
        assert_eq!(
            tracking,
            Tracking {
                upstream: Some("origin/main".into()),
                ahead: 3,
                behind: 12
            }
        );
        assert_eq!(parse_tracking("# branch.head main\0"), Tracking::default());
    }
}
