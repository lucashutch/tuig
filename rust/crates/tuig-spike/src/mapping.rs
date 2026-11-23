//! Maps rows of OpenTUI's `Diff` widget back to file lines.
//!
//! The Rust `Diff` shows only hunk bodies: one row per patch line, with no hunk header rows. `Diff::hunk_lines`
//! returns the first row of each hunk, which is the same data as `DiffRenderable`'s per-hunk row offsets in the
//! TypeScript app. This module ports `renderedDiffLineTarget` and `splitDiffLineTarget` from `src/ui/diff-lines.ts`
//! on top of that, using the same hunk parsing rules as the widget (line counts decide where a hunk ends).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Old,
    New,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Context,
    Added,
    Removed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    /// One-based line number on the selected side.
    pub line: u64,
    pub side: Side,
    pub kind: Kind,
    pub old_line: Option<u64>,
    /// Zero-based row in the raw patch text.
    pub raw_row: usize,
    pub hunk: usize,
}

struct PatchLine {
    kind: Kind,
    old: u64,
    new: u64,
    raw_row: usize,
}

struct Hunk {
    lines: Vec<PatchLine>,
}

/// Parses the first file of a unified patch as the `Diff` widget does. Returns `None` for text it cannot parse.
fn parse(patch: &str) -> Option<Vec<Hunk>> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let (mut old, mut new) = (0u64, 0u64);
    let mut remaining = (0u64, 0u64);
    for (raw_row, line) in patch.lines().enumerate() {
        if remaining == (0, 0) {
            if let Some(header) = line.strip_prefix("@@ ") {
                let ranges = header.split(" @@").next()?;
                let mut parts = ranges.split(' ');
                let range = |part: Option<&str>, sign: char| -> Option<(u64, u64)> {
                    let text = part?.strip_prefix(sign)?;
                    let (start, count) = text.split_once(',').unwrap_or((text, "1"));
                    Some((start.parse().ok()?, count.parse().ok()?))
                };
                let (o, n) = (range(parts.next(), '-')?, range(parts.next(), '+')?);
                (old, new) = (o.0, n.0);
                remaining = (o.1, n.1);
                hunks.push(Hunk { lines: Vec::new() });
            } else if !hunks.is_empty() && line.starts_with("diff ") {
                break;
            }
            continue;
        }
        let (kind, _) = match line.chars().next() {
            None => (Kind::Context, ""),
            Some('\\') => continue,
            Some(' ') => (Kind::Context, &line[1..]),
            Some('+') => (Kind::Added, &line[1..]),
            Some('-') => (Kind::Removed, &line[1..]),
            Some(_) => return None,
        };
        hunks.last_mut()?.lines.push(PatchLine {
            kind,
            old,
            new,
            raw_row,
        });
        if kind != Kind::Added {
            old += 1;
            remaining.0 = remaining.0.checked_sub(1)?;
        }
        if kind != Kind::Removed {
            new += 1;
            remaining.1 = remaining.1.checked_sub(1)?;
        }
    }
    (remaining == (0, 0)).then_some(hunks)
}

fn target(hunk: usize, line: &PatchLine, side: Option<Side>) -> Target {
    match line.kind {
        Kind::Removed => Target {
            line: line.old,
            side: Side::Old,
            kind: line.kind,
            old_line: Some(line.old),
            raw_row: line.raw_row,
            hunk,
        },
        Kind::Added => Target {
            line: line.new,
            side: Side::New,
            kind: line.kind,
            old_line: None,
            raw_row: line.raw_row,
            hunk,
        },
        Kind::Context => Target {
            line: if side == Some(Side::Old) {
                line.old
            } else {
                line.new
            },
            side: side.unwrap_or(Side::New),
            kind: line.kind,
            old_line: Some(line.old),
            raw_row: line.raw_row,
            hunk,
        },
    }
}

/// The first rendered row of each hunk in the unified view. `Diff::hunk_lines` must return the same values.
#[cfg(test)]
pub fn unified_hunk_rows(patch: &str) -> Vec<u32> {
    let mut rows = Vec::new();
    let mut next = 0u32;
    for hunk in parse(patch).unwrap_or_default() {
        rows.push(next);
        next += hunk.lines.len() as u32;
    }
    rows
}

/// Maps a zero-based row of the unified view. `hunk_offsets` is `Diff::hunk_lines()`.
pub fn unified_target(patch: &str, row: u32, hunk_offsets: &[u32]) -> Option<Target> {
    let hunks = parse(patch)?;
    for (index, hunk) in hunks.iter().enumerate() {
        let body_row = row.checked_sub(*hunk_offsets.get(index)?)? as usize;
        if let Some(line) = hunk.lines.get(body_row) {
            return Some(target(index, line, None));
        }
    }
    None
}

/// Maps one side of a row of the split view, where each run of changed lines is padded to equal length.
pub fn split_target(patch: &str, row: u32, side: Side) -> Option<Target> {
    let hunks = parse(patch)?;
    let mut logical = 0u32;
    for (index, hunk) in hunks.iter().enumerate() {
        let mut at = 0;
        while at < hunk.lines.len() {
            if hunk.lines[at].kind == Kind::Context {
                if logical == row {
                    return Some(target(index, &hunk.lines[at], Some(side)));
                }
                logical += 1;
                at += 1;
                continue;
            }
            let (mut removed, mut added) = (Vec::new(), Vec::new());
            while let Some(line) = hunk.lines.get(at).filter(|line| line.kind != Kind::Context) {
                if line.kind == Kind::Removed {
                    removed.push(line)
                } else {
                    added.push(line)
                }
                at += 1;
            }
            let count = removed.len().max(added.len()) as u32;
            if row >= logical && row < logical + count {
                let picked = if side == Side::Old { &removed } else { &added };
                return picked
                    .get((row - logical) as usize)
                    .map(|line| target(index, line, Some(side)));
            }
            logical += count;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "diff --git a/f.rs b/f.rs\nindex 1..2 100644\n--- a/f.rs\n+++ b/f.rs\n\
@@ -1,4 +1,5 @@\n a\n-b\n-c\n+B\n+C\n+D\n d\n\
@@ -20,2 +21,2 @@\n x\n-y\n+Y\n\\ No newline at end of file\n";

    #[test]
    fn unified_rows_map_to_lines() {
        let offsets = unified_hunk_rows(PATCH);
        assert_eq!(offsets, vec![0, 7]);
        let at = |row| unified_target(PATCH, row, &offsets).unwrap();
        assert_eq!(
            (at(0).kind, at(0).line, at(0).raw_row),
            (Kind::Context, 1, 5)
        );
        assert_eq!(
            (at(1).kind, at(1).side, at(1).line),
            (Kind::Removed, Side::Old, 2)
        );
        assert_eq!(
            (at(3).kind, at(3).side, at(3).line),
            (Kind::Added, Side::New, 2)
        );
        assert_eq!(
            (at(6).kind, at(6).line, at(6).old_line),
            (Kind::Context, 5, Some(4))
        );
        // The second hunk starts at row 7; the "\ No newline" marker has no row.
        assert_eq!((at(7).hunk, at(7).line), (1, 21));
        assert_eq!((at(9).kind, at(9).line), (Kind::Added, 22));
        assert!(unified_target(PATCH, 10, &offsets).is_none());
    }

    #[test]
    fn split_rows_pad_changed_runs() {
        // Rows: a | -b/+B | -c/+C | (none)/+D | d | x | -y/+Y
        assert_eq!(split_target(PATCH, 1, Side::Old).unwrap().line, 2);
        assert_eq!(split_target(PATCH, 1, Side::New).unwrap().line, 2);
        assert_eq!(split_target(PATCH, 3, Side::New).unwrap().line, 4);
        assert!(split_target(PATCH, 3, Side::Old).is_none());
        assert_eq!(split_target(PATCH, 4, Side::Old).unwrap().line, 4);
        assert_eq!(split_target(PATCH, 4, Side::New).unwrap().line, 5);
        assert_eq!(split_target(PATCH, 6, Side::Old).unwrap().line, 21);
    }
}
