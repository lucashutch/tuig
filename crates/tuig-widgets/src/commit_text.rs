//! Text for the commit details pane and the file history cards. Ports `src/ui/runtime-presentation-commit.ts`
//! (`presentCommitMeta`, `parseCoAuthors`, the working-changes banner) and the helpers it uses from
//! `src/ui/history.ts` (`shortSha`, `authorInitials`, `formatRelativeTime`) and
//! `src/ui/runtime-presentation-text.ts` (`wrappedLineCount`, `clipColumns`).

use jiff::{Timestamp, tz::TimeZone};
use tuig_git::types::Commit;
use tuig_ui_model::text_width::string_width;

/// The first `length` characters. The TS app slices UTF-16 units. SHAs are ASCII, so the results match.
pub fn short_sha(sha: &str) -> &str {
    let end = sha
        .char_indices()
        .nth(8)
        .map_or(sha.len(), |(index, _)| index);
    &sha[..end]
}

/// Two letters for an author badge. `authorInitials`.
pub fn author_initials(author: &str, email: &str) -> String {
    let source = Some(author.trim())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            Some(email.split('@').next().unwrap_or("").trim()).filter(|name| !name.is_empty())
        })
        .unwrap_or("?");
    let words: Vec<&str> = source
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    let first = |word: &str| word.chars().next().map(String::from).unwrap_or_default();
    let initials = match words.as_slice() {
        [] => "?".to_string(),
        [one] => one.chars().take(2).collect(),
        [first_word, .., last] => format!("{}{}", first(first_word), first(last)),
    };
    // NFKD then dropping marks: ASCII letters and digits survive. Other letters stay as they are, which is
    // what TS keeps for names that are not decomposable.
    let safe: String = initials.chars().filter(|c| c.is_alphanumeric()).collect();
    let safe = if safe.is_empty() {
        "?".to_string()
    } else {
        safe
    };
    safe.chars().take(2).collect::<String>().to_uppercase()
}

/// `[AB]`, the badge in history rows and file history cards.
pub fn author_avatar(author: &str, email: &str) -> String {
    format!("[{}]", author_initials(author, email))
}

/// The three-row badge that replaces the author photo. `boxedAuthorAvatar`.
pub fn boxed_author_avatar(author: &str, email: &str) -> String {
    let initials = author_initials(author, email);
    let padded = format!("{initials:<2}");
    format!("┌────┐\n│ {padded} │\n└────┘")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoAuthor {
    pub name: String,
    pub email: String,
}

/// The `Co-authored-by:` trailers in a commit body. `parseCoAuthors`.
pub fn parse_co_authors(body: &str) -> Vec<CoAuthor> {
    body.lines()
        .filter_map(|line| {
            let rest = strip_prefix_ignore_case(line.trim_start(), "co-authored-by:")?;
            let rest = rest.trim_end().strip_suffix('>')?;
            let open = rest.rfind('<')?;
            let (name, email) = (rest[..open].trim(), rest[open + 1..].trim());
            if name.is_empty() || email.is_empty() || email.contains(['<', '>', '\r', '\n']) {
                return None;
            }
            Some(CoAuthor {
                name: name.to_string(),
                email: email.to_string(),
            })
        })
        .collect()
}

fn strip_prefix_ignore_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// `Mar 1, 2024, 2:00 PM` in the local time zone. `formatCommitDate` with the `en-US` medium date and short time.
/// A value that is not a date comes back as it is.
pub fn format_commit_date(value: &str) -> String {
    match value.parse::<Timestamp>() {
        Ok(timestamp) => timestamp
            .to_zoned(TimeZone::system())
            .strftime("%b %-d, %Y, %-I:%M %p")
            .to_string(),
        Err(_) => value.to_string(),
    }
}

/// `3h ago`, `in 2d`, `just now`. `formatRelativeTime`.
pub fn format_relative_time(value: &str, now: Timestamp) -> String {
    let Ok(timestamp) = value.parse::<Timestamp>() else {
        return "unknown time".to_string();
    };
    let delta = now.as_millisecond() - timestamp.as_millisecond();
    // JS `Math.round` rounds halves toward positive infinity.
    let seconds = (delta as f64 / 1000.0 + 0.5).floor() as i64;
    let future = seconds < 0;
    let amount = seconds.unsigned_abs();
    if amount < 10 {
        return if future { "in a moment" } else { "just now" }.to_string();
    }
    const UNITS: [(u64, &str); 7] = [
        (60, "s"),
        (60, "m"),
        (24, "h"),
        (7, "d"),
        (4, "w"),
        (12, "mo"),
        (u64::MAX, "y"),
    ];
    let (mut rest, mut unit) = (amount, "s");
    for (size, name) in UNITS {
        unit = name;
        if rest < size {
            break;
        }
        rest /= size;
    }
    if future {
        format!("in {rest}{unit}")
    } else {
        format!("{rest}{unit} ago")
    }
}

/// Lines a text takes at `width` columns. The TS app counts UTF-16 units, not cells. `wrappedLineCount`.
pub fn wrapped_line_count(value: &str, width: i64) -> i64 {
    let width = width.max(1);
    let lines: i64 = value
        .split('\n')
        .map(|line| {
            let length = line.encode_utf16().count() as i64;
            ((length + width - 1) / width).max(1)
        })
        .sum();
    lines.max(1)
}

/// Cuts `value` to `width` cells with a trailing ellipsis. `clipColumns`.
pub fn clip_columns(value: &str, width: i64) -> String {
    if width <= 0 {
        return String::new();
    }
    let width = width as usize;
    if string_width(value) <= width {
        return value.to_string();
    }
    let target = width.saturating_sub(1);
    let mut result = String::new();
    for c in value.chars() {
        let mut next = result.clone();
        next.push(c);
        if string_width(&next) > target {
            break;
        }
        result = next;
    }
    result.push('…');
    result
}

/// What the details pane prints for one commit. `info` is the identity card: the first line is the author in the
/// text color, the rest is muted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitText {
    pub author: String,
    pub muted: Vec<String>,
    pub header: String,
    pub body: String,
}

impl CommitText {
    /// The plain text of the identity card, as the layout measures it.
    pub fn info(&self) -> String {
        let mut info = self.author.clone();
        for line in &self.muted {
            info.push('\n');
            info.push_str(line);
        }
        info
    }
}

/// `presentCommitMeta`.
pub fn present_commit_text(commit: &Commit) -> CommitText {
    let body = commit
        .body
        .as_deref()
        .map(strip_leading_blank_lines)
        .filter(|body| !body.is_empty())
        .unwrap_or("(no body)")
        .to_string();
    let mut muted = Vec::new();
    if !commit.author_email.is_empty() {
        muted.push(commit.author_email.clone());
    }
    muted.push(format_commit_date(&commit.authored_at));
    if !commit.parents.is_empty() {
        let parents: Vec<&str> = commit.parents.iter().map(|p| short_sha(p)).collect();
        muted.push(format!("Parent: {}", parents.join(", ")));
    }
    if commit.committer != commit.author || commit.committer_email != commit.author_email {
        let email = if commit.committer_email.is_empty() {
            String::new()
        } else {
            format!(" <{}>", commit.committer_email)
        };
        muted.push(format!("Committed by {}{email}", commit.committer));
        muted.push(format!(
            "Committed: {}",
            format_commit_date(&commit.committed_at)
        ));
    }
    CommitText {
        author: commit.author.clone(),
        muted,
        header: commit.subject.clone(),
        body,
    }
}

/// `body.replace(/^(?:[ \t]*\n)+/, "")`.
fn strip_leading_blank_lines(body: &str) -> &str {
    let mut rest = body;
    while let Some(end) = rest.find('\n') {
        if rest[..end].chars().all(|c| c == ' ' || c == '\t') {
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    rest
}

/// Rows of the working-changes banner above the message card. `workingChangesBannerRows`.
pub fn working_changes_banner_rows(file_count: usize) -> i64 {
    if file_count > 0 { 2 } else { 0 }
}

/// The two banner rows. The action row can never be clipped away. `workingChangesBannerLines`.
pub fn working_changes_banner_lines(file_count: usize, width: i64) -> Vec<String> {
    if file_count == 0 {
        return Vec::new();
    }
    let plural = if file_count == 1 { "" } else { "s" };
    vec![
        clip_columns(
            &format!("{file_count} file change{plural} in working directory"),
            width.max(1),
        ),
        clip_columns("View Changes", width.max(1)),
    ]
}

#[cfg(test)]
#[path = "commit_text_tests.rs"]
mod tests;
