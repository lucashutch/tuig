//! Splits a file diff into hunks and builds patches for selected lines.
//! Port of `src/git/hunks.ts`.

use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    pub index: usize,
    pub header: String,
    pub patch: String,
}

/// Which side of unselected changes stays in a line patch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Preserve {
    /// Unselected removals stay as context and unselected additions drop out.
    /// Use this to stage lines from an unstaged diff.
    #[default]
    Old,
    /// Unselected additions stay as context and unselected removals drop out.
    /// Use this to unstage or discard lines.
    New,
}

/// Byte offsets where a line starts with `@@ `. JavaScript's `^` in multiline
/// mode also starts a line after `\r`, U+2028, and U+2029, so this does too.
fn hunk_starts(text: &str) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut at_line_start = true;
    for (offset, c) in text.char_indices() {
        if at_line_start && text[offset..].starts_with("@@ ") {
            starts.push(offset);
        }
        at_line_start = matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    }
    starts
}

/// Splits a one-file unified Git diff into independently applicable patches.
pub fn split_patch_hunks(patch: &str) -> Vec<DiffHunk> {
    let starts = hunk_starts(patch);
    let Some(&first) = starts.first() else {
        return Vec::new();
    };
    let preamble = &patch[..first];
    starts
        .iter()
        .enumerate()
        .map(|(index, &start)| {
            let end = starts.get(index + 1).copied().unwrap_or(patch.len());
            let section = &patch[start..end];
            DiffHunk {
                index,
                header: section.split('\n').next().unwrap_or("@@").to_string(),
                patch: format!("{preamble}{section}"),
            }
        })
        .collect()
}

struct HunkHeader<'a> {
    old_start: u64,
    new_start: u64,
    suffix: &'a str,
}

/// Matches `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/` on one line.
fn parse_hunk_header(line: &str) -> Option<HunkHeader<'_>> {
    fn number(text: &str) -> Option<(u64, &str)> {
        let len = text.bytes().take_while(u8::is_ascii_digit).count();
        (len > 0).then(|| (text[..len].parse().unwrap_or(u64::MAX), &text[len..]))
    }
    fn optional_count(text: &str) -> &str {
        match text.strip_prefix(',').and_then(number) {
            Some((_, rest)) => rest,
            None => text,
        }
    }
    let rest = line.strip_prefix("@@ -")?;
    let (old_start, rest) = number(rest)?;
    let rest = optional_count(rest).strip_prefix(" +")?;
    let (new_start, rest) = number(rest)?;
    let suffix = optional_count(rest).strip_prefix(" @@")?;
    // `.` does not match line terminators.
    if suffix.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(HunkHeader {
        old_start,
        new_start,
        suffix,
    })
}

/// Build an applicable patch containing only the selected changed rows.
///
/// `selected_rows` holds indexes into `patch.split('\n')`. Returns an empty
/// string when no selected row changes anything.
pub fn select_patch_lines(
    patch: &str,
    selected_rows: &HashSet<usize>,
    preserve: Preserve,
) -> String {
    if selected_rows.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = patch.split('\n').collect();
    let Some(first_hunk) = lines.iter().position(|l| l.starts_with("@@ ")) else {
        return String::new();
    };
    let preamble = &lines[..first_hunk];
    let mut output: Vec<String> = Vec::new();
    let mut index = first_hunk;
    while index < lines.len() {
        let Some(header) = parse_hunk_header(lines[index]) else {
            index += 1;
            continue;
        };
        let mut old_start = header.old_start;
        index += 1;
        let mut body: Vec<String> = Vec::new();
        let mut old_count = 0usize;
        let mut new_count = 0usize;
        let mut changed = false;
        let mut previous_row_kept = false;
        while index < lines.len() && !lines[index].starts_with("@@ ") {
            let line = lines[index];
            if line.starts_with("diff --git ") {
                break;
            }
            if line.is_empty() && index == lines.len() - 1 {
                index += 1;
                break;
            }
            if line.starts_with("\\ No newline at end of file") {
                if previous_row_kept {
                    body.push(line.to_string());
                }
            } else if let Some(text) = line.strip_prefix('+') {
                if selected_rows.contains(&index) {
                    body.push(line.to_string());
                    new_count += 1;
                    changed = true;
                    previous_row_kept = true;
                } else if preserve == Preserve::New {
                    body.push(format!(" {text}"));
                    old_count += 1;
                    new_count += 1;
                    previous_row_kept = true;
                } else {
                    previous_row_kept = false;
                }
            } else if let Some(text) = line.strip_prefix('-') {
                if selected_rows.contains(&index) {
                    body.push(line.to_string());
                    old_count += 1;
                    changed = true;
                    previous_row_kept = true;
                } else if preserve == Preserve::Old {
                    body.push(format!(" {text}"));
                    old_count += 1;
                    new_count += 1;
                    previous_row_kept = true;
                } else {
                    if body.is_empty() {
                        old_start = old_start.saturating_add(1);
                    }
                    previous_row_kept = false;
                }
            } else {
                body.push(line.to_string());
                old_count += 1;
                new_count += 1;
                previous_row_kept = true;
            }
            index += 1;
        }
        if changed {
            output.push(format!(
                "@@ -{old_start},{old_count} +{},{new_count} @@{}",
                header.new_start, header.suffix
            ));
            output.extend(body);
        }
    }
    if output.is_empty() {
        return String::new();
    }
    let all: Vec<&str> = preamble
        .iter()
        .copied()
        .chain(output.iter().map(String::as_str))
        .collect();
    format!("{}\n", all.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{RunOptions, run_git, run_git_with};
    use crate::test_util::{commit, temp_repo};

    const PATCH: &str = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,4 +1,5 @@\n same\n-old one\n-old two\n+new one\n+new two\n+extra\n tail\n";

    fn rows(items: &[usize]) -> HashSet<usize> {
        items.iter().copied().collect()
    }

    fn row_of(patch: &str, line: &str) -> usize {
        patch.split('\n').position(|l| l == line).unwrap()
    }

    #[test]
    fn keeps_selected_additions_and_omits_adjacent_additions() {
        let selected = select_patch_lines(PATCH, &rows(&[7, 9]), Preserve::Old);
        assert!(selected.contains("+new one"));
        assert!(selected.contains("+extra"));
        assert!(!selected.contains("+new two"));
        assert!(selected.contains("@@ -1,4 +1,6 @@"));
    }

    #[test]
    fn turns_unselected_removals_into_context() {
        let selected = select_patch_lines(PATCH, &rows(&[5]), Preserve::Old);
        assert!(selected.contains("-old one"));
        assert!(selected.contains(" old two"));
        assert!(!selected.contains("+new one"));
        assert!(selected.contains("@@ -1,4 +1,3 @@"));
    }

    #[test]
    fn returns_no_patch_without_selected_changes() {
        assert_eq!(select_patch_lines(PATCH, &rows(&[]), Preserve::Old), "");
        assert_eq!(select_patch_lines(PATCH, &rows(&[4]), Preserve::Old), "");
    }

    #[test]
    fn drops_a_no_newline_marker_with_an_omitted_line() {
        let with_marker = PATCH.replace(
            "+new two\n+extra",
            "+new two\n\\ No newline at end of file\n+extra",
        );
        let selected = select_patch_lines(
            &with_marker,
            &rows(&[row_of(&with_marker, "+extra")]),
            Preserve::Old,
        );
        assert!(selected.contains("+extra"));
        assert!(!selected.contains("No newline at end of file"));
    }

    #[test]
    fn preserve_new_drops_unselected_removals_and_shifts_the_old_start() {
        // Unselected removals drop out and unselected additions become context.
        let selected = select_patch_lines(PATCH, &rows(&[7]), Preserve::New);
        assert!(selected.contains("@@ -1,4 +1,5 @@"));
        assert!(!selected.contains("-old"));
        assert!(selected.contains(" new two"));
        assert!(selected.contains("+new one"));
    }

    #[test]
    fn keeps_the_hunk_suffix_and_each_changed_hunk_only() {
        let two = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@ fn one\n-a\n+b\n@@ -9 +9 @@ fn two\n-c\n+d\n";
        let selected = select_patch_lines(two, &rows(&[7, 8]), Preserve::Old);
        assert!(!selected.contains("fn one"));
        assert_eq!(
            selected,
            "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -9,1 +9,1 @@ fn two\n-c\n+d\n"
        );
    }

    #[test]
    fn splits_a_patch_while_retaining_file_headers() {
        let patch =
            "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d\n";
        let hunks = split_patch_hunks(patch);
        assert_eq!(hunks.len(), 2);
        assert!(hunks[1].patch.contains("diff --git"));
        assert_eq!(hunks[1].header, "@@ -3 +3 @@");
        assert_eq!(hunks[1].index, 1);
        assert!(split_patch_hunks("diff --git a/a b/a\nBinary files differ\n").is_empty());
    }

    fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
        run_git(args, Some(dir)).unwrap().stdout
    }

    fn apply(dir: &std::path::Path, patch: &str, args: &[&str]) {
        let options = RunOptions {
            stdin: Some(patch.as_bytes().to_vec()),
            ..RunOptions::in_dir(dir)
        };
        run_git_with(args, &options).unwrap();
    }

    #[test]
    fn stages_unstages_and_discards_only_selected_lines() {
        let repo = temp_repo();
        let dir = repo.path();
        let file = dir.join("a.txt");
        std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
        git_in(dir, &["add", "a.txt"]);
        commit(dir, "base");
        std::fs::write(&file, "ONE\ntwo\nTHREE\n").unwrap();

        let diff = git_in(dir, &["diff", "--no-ext-diff", "-U3", "--", "a.txt"]);
        let one_rows = rows(&[row_of(&diff, "-one"), row_of(&diff, "+ONE")]);

        apply(
            dir,
            &select_patch_lines(&diff, &one_rows, Preserve::Old),
            &["apply", "--cached"],
        );
        assert_eq!(git_in(dir, &["show", ":a.txt"]), "ONE\ntwo\nthree\n");

        let staged = git_in(
            dir,
            &["diff", "--no-ext-diff", "--cached", "-U3", "--", "a.txt"],
        );
        let staged_rows = rows(&[row_of(&staged, "-one"), row_of(&staged, "+ONE")]);
        apply(
            dir,
            &select_patch_lines(&staged, &staged_rows, Preserve::New),
            &["apply", "--cached", "--reverse"],
        );
        assert_eq!(git_in(dir, &["show", ":a.txt"]), "one\ntwo\nthree\n");

        apply(
            dir,
            &select_patch_lines(&diff, &one_rows, Preserve::New),
            &["apply", "--reverse"],
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "one\ntwo\nTHREE\n");

        std::fs::write(&file, "ONE\ntwo\nTHREE\n").unwrap();
        git_in(dir, &["add", "a.txt"]);
        let full = git_in(
            dir,
            &["diff", "--no-ext-diff", "--cached", "-U3", "--", "a.txt"],
        );
        let full_rows = rows(&[row_of(&full, "-one"), row_of(&full, "+ONE")]);
        apply(
            dir,
            &select_patch_lines(&full, &full_rows, Preserve::New),
            &["apply", "--cached", "--reverse"],
        );
        assert_eq!(git_in(dir, &["show", ":a.txt"]), "one\ntwo\nTHREE\n");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "ONE\ntwo\nTHREE\n");
    }
}
