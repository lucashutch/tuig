//! Mapping from diff display rows to file lines. Ports `src/ui/diff-lines.ts`.
//!
//! Row arguments are `i64` because callers subtract hunk offsets from them.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffSide {
    Old,
    New,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffLineTarget {
    /// One-based line number in the selected side of the file.
    pub line: u64,
    pub side: DiffSide,
    pub kind: DiffLineKind,
    pub old_line: Option<u64>,
    /// Zero-based row in the raw unified patch.
    pub raw_row: usize,
    /// Zero-based body row used by the unified diff renderer.
    pub rendered_row: usize,
}

const NO_NEWLINE: &str = "\\ No newline at end of file";

fn digits(text: &str) -> Option<(u64, &str)> {
    let end = text.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return None;
    }
    let value = text[..end].bytes().fold(0u64, |n, d| {
        n.saturating_mul(10).saturating_add(u64::from(d - b'0'))
    });
    Some((value, &text[end..]))
}

/// Parses `@@ -a[,b] +c[,d] @@` at the start of `text` into `(a, c)`.
fn parse_hunk_header(text: &str) -> Option<(u64, u64)> {
    let rest = text.strip_prefix("@@ -")?;
    let (old, rest) = digits(rest)?;
    let rest = match rest.strip_prefix(',') {
        Some(after) => digits(after)?.1,
        None => rest,
    };
    let rest = rest.strip_prefix(" +")?;
    let (new, rest) = digits(rest)?;
    let rest = match rest.strip_prefix(',') {
        Some(after) => digits(after)?.1,
        None => rest,
    };
    rest.starts_with(" @@").then_some((old, new))
}

/// Map a zero-based rendered unified-diff row to a file line.
///
/// Headers and no-newline markers have no target.
pub fn diff_line_target(diff: &str, row: i64) -> Option<DiffLineTarget> {
    if row < 0 {
        return None;
    }
    let row = row as usize;
    let mut old_line = 0u64;
    let mut new_line = 0u64;
    let mut in_hunk = false;
    let mut rendered_row = 0usize;
    for (index, text) in diff.split('\n').enumerate() {
        if let Some((old, new)) = parse_hunk_header(text) {
            old_line = old;
            new_line = new;
            in_hunk = true;
            continue;
        }
        if !in_hunk || text.starts_with('\\') {
            continue;
        }
        let old_at = old_line;
        let new_at = new_line;
        if text.starts_with('-') {
            old_line += 1;
        } else if text.starts_with('+') {
            new_line += 1;
        } else {
            old_line += 1;
            new_line += 1;
        }
        let current = rendered_row;
        rendered_row += 1;
        if index != row {
            continue;
        }
        return Some(if text.starts_with('-') {
            DiffLineTarget {
                line: old_at,
                side: DiffSide::Old,
                kind: DiffLineKind::Removed,
                old_line: Some(old_at),
                raw_row: index,
                rendered_row: current,
            }
        } else if text.starts_with('+') {
            DiffLineTarget {
                line: new_at,
                side: DiffSide::New,
                kind: DiffLineKind::Added,
                old_line: None,
                raw_row: index,
                rendered_row: current,
            }
        } else {
            DiffLineTarget {
                line: new_at,
                side: DiffSide::New,
                kind: DiffLineKind::Context,
                old_line: Some(old_at),
                raw_row: index,
                rendered_row: current,
            }
        });
    }
    None
}

/// Map a unified diff body row, using the renderer's per-hunk row offsets.
pub fn rendered_diff_line_target(
    diff: &str,
    row: i64,
    hunk_offsets: &[i64],
) -> Option<DiffLineTarget> {
    let lines: Vec<&str> = diff.split('\n').collect();
    let mut hunks: Vec<usize> = Vec::new();
    for text in &lines {
        if text.starts_with("@@ ") {
            hunks.push(0);
        } else if let Some(count) = hunks.last_mut()
            && !text.starts_with("diff --git ")
            && !text.starts_with(NO_NEWLINE)
        {
            *count += 1;
        }
    }
    for (hunk, offset) in hunk_offsets.iter().enumerate() {
        let body_row = row - offset;
        let Some(&body_len) = hunks.get(hunk) else {
            continue;
        };
        if body_row < 0 || body_row >= body_len as i64 {
            continue;
        }
        let mut raw_row = 0i64;
        let mut seen: i64 = -1;
        for (index, line) in lines.iter().enumerate() {
            let header = line.starts_with("@@ ");
            if header {
                seen += 1;
            }
            if seen == hunk as i64 && !header && !line.starts_with(NO_NEWLINE) {
                let this = raw_row;
                raw_row += 1;
                if this == body_row {
                    return diff_line_target(diff, index as i64);
                }
            }
        }
    }
    None
}

/// Map one side of an aligned split-diff row back to the unified patch.
pub fn split_diff_line_target(diff: &str, row: i64, side: DiffSide) -> Option<DiffLineTarget> {
    if row < 0 {
        return None;
    }
    let lines: Vec<&str> = diff.split('\n').collect();
    let mut logical_row = 0i64;
    let mut in_hunk = false;
    let mut index = 0;
    while index < lines.len() {
        let text = lines[index];
        if text.starts_with("@@ ") {
            in_hunk = true;
            index += 1;
            continue;
        }
        if !in_hunk || text.starts_with('\\') {
            index += 1;
            continue;
        }
        if text.starts_with(' ') {
            let this = logical_row;
            logical_row += 1;
            if this == row {
                return diff_line_target(diff, index as i64);
            }
            index += 1;
            continue;
        }
        let mut removed = Vec::new();
        let mut added = Vec::new();
        while index < lines.len() {
            if lines[index].starts_with('-') {
                removed.push(index);
            } else if lines[index].starts_with('+') {
                added.push(index);
            } else {
                break;
            }
            index += 1;
        }
        let count = removed.len().max(added.len()) as i64;
        if count == 0 {
            index += 1;
            continue;
        }
        if row >= logical_row && row < logical_row + count {
            let picked = match side {
                DiffSide::Old => &removed,
                DiffSide::New => &added,
            };
            return picked
                .get((row - logical_row) as usize)
                .and_then(|raw| diff_line_target(diff, *raw as i64));
        }
        logical_row += count;
    }
    None
}

/// Changed raw patch rows crossed by a drag range, inclusive.
pub fn changed_diff_rows_in_range(diff: &str, from: i64, to: i64) -> Vec<usize> {
    let start = from.min(to).max(0);
    let end = from.max(to);
    (start..=end)
        .filter(|row| {
            diff_line_target(diff, *row).is_some_and(|target| target.kind != DiffLineKind::Context)
        })
        .map(|row| row as usize)
        .collect()
}
