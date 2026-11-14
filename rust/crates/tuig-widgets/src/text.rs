//! Column fitting. Ports `fitColumns` from `src/ui/runtime-presentation-text.ts`.
//!
//! Widths come from `unicode-width`, where TypeScript uses `Bun.stringWidth`. Both count East Asian ambiguous
//! characters (such as `●` and `…`) and private-use Nerd Font icons as one cell.

use unicode_width::UnicodeWidthChar;

/// Terminal cells `text` takes.
pub fn str_width(text: &str) -> usize {
    text.chars().map(|c| c.width().unwrap_or(0)).sum()
}

/// Pads or truncates `value` to exactly `width` cells. With `ellipsis`, a truncated value ends in `…`.
pub fn fit_columns(value: &str, width: i64, ellipsis: bool) -> String {
    if width <= 0 {
        return String::new();
    }
    let width = width as usize;
    let current = str_width(value);
    if current <= width {
        return format!("{value}{}", " ".repeat(width - current));
    }
    let suffix = if ellipsis && width > 1 { "…" } else { "" };
    let target = width - str_width(suffix);
    let mut result = String::new();
    let mut used = 0;
    for character in value.chars() {
        let cells = character.width().unwrap_or(0);
        if used + cells > target {
            break;
        }
        used += cells;
        result.push(character);
    }
    result.push_str(suffix);
    let used = str_width(&result);
    format!("{result}{}", " ".repeat(width.saturating_sub(used)))
}
