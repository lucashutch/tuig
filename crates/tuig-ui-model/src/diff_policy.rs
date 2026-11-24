//! Display limits for diffs. Ports `src/ui/diff-policy.ts`.

/// Limits apply to display only. Git mutations still read complete patches.
pub const DIFF_HIGHLIGHT_MAX_BYTES: usize = 1024 * 1024;
pub const DIFF_HIGHLIGHT_MAX_LINES: usize = 20_000;
pub const DIFF_DISPLAY_MAX_BYTES: usize = 5 * 1024 * 1024;

pub fn can_highlight_diff(value: &str) -> bool {
    if value.len() >= DIFF_HIGHLIGHT_MAX_BYTES {
        return false;
    }
    let mut lines = 1;
    for byte in value.bytes() {
        if byte == b'\n' {
            lines += 1;
            if lines >= DIFF_HIGHLIGHT_MAX_LINES {
                return false;
            }
        }
    }
    true
}
