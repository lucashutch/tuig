//! Command palette filtering and ranking.
//!
//! The TypeScript `PaletteCommand.run` callback is not part of this model. The UI layer maps a
//! command `id` to its action.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandCategory {
    Repository,
    Changes,
    Navigation,
    View,
    Settings,
}

const CATEGORY_ORDER: [CommandCategory; 5] = [
    CommandCategory::Repository,
    CommandCategory::Changes,
    CommandCategory::Navigation,
    CommandCategory::View,
    CommandCategory::Settings,
];

impl CommandCategory {
    pub fn label(self) -> &'static str {
        match self {
            Self::Repository => "Repository",
            Self::Changes => "Changes",
            Self::Navigation => "Navigation",
            Self::View => "View",
            Self::Settings => "Settings",
        }
    }

    fn order(self) -> i64 {
        CATEGORY_ORDER.iter().position(|c| *c == self).unwrap_or(0) as i64
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteCommand {
    pub id: String,
    pub title: String,
    pub category: CommandCategory,
    pub keywords: Vec<String>,
    pub shortcut: Option<String>,
    /// `None` means enabled. Only `Some(false)` disables a command.
    pub enabled: Option<bool>,
    pub disabled_reason: Option<String>,
}

impl PaletteCommand {
    pub fn new(id: impl Into<String>, title: impl Into<String>, category: CommandCategory) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            category,
            keywords: Vec::new(),
            shortcut: None,
            enabled: None,
            disabled_reason: None,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled != Some(false)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PaletteMatch<'a> {
    pub command: &'a PaletteCommand,
    pub score: i64,
}

/// Lowercase, replace each run of characters outside `a-z0-9` with one space, and trim.
fn normalize(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut gap = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(ch);
        } else {
            gap = true;
        }
    }
    out
}

/// Both inputs come from `normalize`, so they are ASCII and byte offsets equal string indices.
fn subsequence_score(query: &str, value: &str) -> Option<i64> {
    let value = value.as_bytes();
    let mut at = 0usize;
    let mut gaps = 0i64;
    for ch in query.bytes() {
        let found = at + value.get(at..)?.iter().position(|b| *b == ch)?;
        gaps += (found - at) as i64;
        at = found + 1;
    }
    Some(300 - gaps)
}

/// Rank commands without hiding unavailable actions, so the palette teaches scope.
pub fn command_matches<'a>(commands: &'a [PaletteCommand], query: &str) -> Vec<PaletteMatch<'a>> {
    let normalized = normalize(query);
    let tokens: Vec<&str> = normalized.split(' ').filter(|t| !t.is_empty()).collect();
    let mut matches: Vec<PaletteMatch<'a>> = commands
        .iter()
        .enumerate()
        .filter_map(|(index, command)| {
            let index = index as i64;
            if normalized.is_empty() {
                return Some(PaletteMatch {
                    command,
                    score: 10_000 - command.category.order() * 1_000 - index,
                });
            }
            let title = normalize(&command.title);
            let words: Vec<&str> = title.split(' ').collect();
            let mut parts = vec![command.title.as_str(), command.category.label()];
            parts.extend(command.keywords.iter().map(String::as_str));
            let searchable = normalize(&parts.join(" "));
            let mut score = 0i64;
            for token in &tokens {
                if title == *token {
                    score += 1_000;
                } else if title.starts_with(token) {
                    score += 800;
                } else if words.iter().any(|word| word.starts_with(token)) {
                    score += 650;
                } else if searchable.contains(token) {
                    score += 500;
                } else {
                    score += subsequence_score(token, &searchable)?;
                }
            }
            Some(PaletteMatch {
                command,
                score: score * 1_000 - index,
            })
        })
        .collect();
    // `sort_by` is stable, like `Array.prototype.sort`.
    matches.sort_by_key(|m| std::cmp::Reverse(m.score));
    matches
}

/// Move the selection by `delta`, skipping disabled commands without wrapping. Returns -1 when
/// nothing is selectable.
pub fn next_enabled_command(matches: &[PaletteMatch<'_>], current: isize, delta: isize) -> isize {
    if matches.is_empty() {
        return -1;
    }
    let enabled_at = |index: isize| {
        usize::try_from(index)
            .ok()
            .and_then(|i| matches.get(i))
            .is_none_or(|m| m.command.is_enabled())
    };
    let mut index = current;
    loop {
        index += delta;
        if index < 0 || index >= matches.len() as isize {
            return if enabled_at(current) { current } else { -1 };
        }
        if enabled_at(index) {
            return index;
        }
    }
}

pub fn clamp_palette_viewport(selected: i64, start: i64, rows: i64, count: i64) -> i64 {
    let maximum = (count - rows).max(0);
    if selected < start {
        return selected.max(0);
    }
    if selected >= start + rows {
        return maximum.min(selected - rows + 1);
    }
    maximum.min(start.max(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use CommandCategory::*;

    fn ids(matches: &[PaletteMatch<'_>]) -> Vec<String> {
        matches.iter().map(|m| m.command.id.clone()).collect()
    }

    #[test]
    fn ranks_exact_and_prefix_title_matches_ahead_of_keyword_matches() {
        let mut force = PaletteCommand::new("force", "Publish branch", Repository);
        force.keywords = vec!["push".into()];
        let commands = [
            PaletteCommand::new("push", "Push", Repository),
            force,
            PaletteCommand::new("pull", "Pull", Repository),
        ];
        assert_eq!(ids(&command_matches(&commands, "push")), ["push", "force"]);
    }

    #[test]
    fn supports_multi_token_and_ordered_fuzzy_matching() {
        let commands = [
            PaletteCommand::new("filter", "Filter branches", Navigation),
            PaletteCommand::new("fetch", "Fetch from remotes", Repository),
        ];
        assert_eq!(
            command_matches(&commands, "fil bra")[0].command.id,
            "filter"
        );
        assert_eq!(command_matches(&commands, "ftch")[0].command.id, "fetch");
    }

    #[test]
    fn matches_on_category_text_and_ignores_punctuation() {
        let commands = [
            PaletteCommand::new("a", "Open", Settings),
            PaletteCommand::new("b", "Open", View),
        ];
        assert_eq!(ids(&command_matches(&commands, "  VIEW!! ")), ["b"]);
        assert!(command_matches(&commands, "zzz").is_empty());
    }

    #[test]
    fn empty_query_orders_by_category_then_position() {
        let commands = [
            PaletteCommand::new("s", "S", Settings),
            PaletteCommand::new("r2", "R2", Repository),
            PaletteCommand::new("c", "C", Changes),
            PaletteCommand::new("r1", "R1", Repository),
        ];
        assert_eq!(ids(&command_matches(&commands, "")), ["r2", "r1", "c", "s"]);
    }

    #[test]
    fn keeps_disabled_matches_visible() {
        let mut pull = PaletteCommand::new("pull", "Pull", Repository);
        pull.enabled = Some(false);
        pull.disabled_reason = Some("No upstream".into());
        let commands = [pull];
        assert_eq!(command_matches(&commands, "pull")[0].command, &commands[0]);
    }

    #[test]
    fn navigation_skips_disabled_commands_without_wrapping() {
        let mut two = PaletteCommand::new("two", "Two", Repository);
        two.enabled = Some(false);
        let commands = [
            PaletteCommand::new("one", "One", Repository),
            two,
            PaletteCommand::new("three", "Three", Repository),
        ];
        let matches = command_matches(&commands, "");
        assert_eq!(next_enabled_command(&matches, 0, 1), 2);
        assert_eq!(next_enabled_command(&matches, 2, 1), 2);
        assert_eq!(next_enabled_command(&matches, 0, -1), 0);
        assert_eq!(next_enabled_command(&[], 0, 1), -1);
    }

    #[test]
    fn viewport_follows_the_selected_command() {
        assert_eq!(clamp_palette_viewport(5, 0, 4, 10), 2);
        assert_eq!(clamp_palette_viewport(1, 4, 4, 10), 1);
        assert_eq!(clamp_palette_viewport(8, 8, 4, 10), 6);
    }
}
