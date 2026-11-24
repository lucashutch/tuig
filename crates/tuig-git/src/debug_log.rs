//! The debug log. Port of `src/ui/debug-log.ts`.
//!
//! The TUI owns the terminal, so failures that would be printed go to `<cache>/tuig/debug.log` instead. Logging is
//! off unless `TUIG_DEBUG` is set. A write that fails is ignored, because a broken log must not stop the UI.

use std::fmt::Display;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// `XDG_CACHE_HOME` or `~/.cache`, then `tuig/debug.log`.
pub fn log_path() -> PathBuf {
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .unwrap_or_else(|| PathBuf::from(".cache"));
    cache.join("tuig").join("debug.log")
}

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    // `Boolean(process.env.TUIG_DEBUG)`: set and not empty.
    *ENABLED.get_or_init(|| std::env::var_os("TUIG_DEBUG").is_some_and(|value| !value.is_empty()))
}

/// Formats `time` as `Date.prototype.toISOString` does: UTC with milliseconds.
pub fn iso_timestamp(time: SystemTime) -> String {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64);
    let days = millis.div_euclid(86_400_000);
    let of_day = millis.rem_euclid(86_400_000);
    // Civil date from a day count (Howard Hinnant's `civil_from_days`).
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

/// The line `debugLog` writes: `<iso time> [scope] message`, then `: detail` for an error.
pub fn format_line(
    time: SystemTime,
    scope: &str,
    message: &str,
    error: Option<&dyn Display>,
) -> String {
    let detail = error.map(|error| format!(": {error}")).unwrap_or_default();
    format!("{} [{scope}] {message}{detail}\n", iso_timestamp(time))
}

/// Appends a line to the debug log when `TUIG_DEBUG` is set.
pub fn debug_log(scope: &str, message: &str) {
    write_line(scope, message, None);
}

/// As [`debug_log`], with the error's text after the message.
pub fn debug_log_error(scope: &str, message: &str, error: &dyn Display) {
    write_line(scope, message, Some(error));
}

fn write_line(scope: &str, message: &str, error: Option<&dyn Display>) {
    if !enabled() {
        return;
    }
    let line = format_line(SystemTime::now(), scope, message, error);
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(line.as_bytes()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn timestamps_match_to_iso_string() {
        let at = |millis: u64| UNIX_EPOCH + Duration::from_millis(millis);
        assert_eq!(iso_timestamp(at(0)), "1970-01-01T00:00:00.000Z");
        // 2024-02-29 12:34:56.789, a leap day: `new Date(1709210096789).toISOString()`.
        assert_eq!(
            iso_timestamp(at(1_709_210_096_789)),
            "2024-02-29T12:34:56.789Z"
        );
        // 2000-03-01 00:00:00.001, the day after a century leap day.
        assert_eq!(
            iso_timestamp(at(951_868_800_001)),
            "2000-03-01T00:00:00.001Z"
        );
    }

    #[test]
    fn a_line_has_scope_message_and_error_detail() {
        let at = UNIX_EPOCH + Duration::from_millis(1_709_210_096_789);
        assert_eq!(
            format_line(at, "history", "appended 250 commits", None),
            "2024-02-29T12:34:56.789Z [history] appended 250 commits\n"
        );
        assert_eq!(
            format_line(at, "avatar", "fetch failed", Some(&"timed out")),
            "2024-02-29T12:34:56.789Z [avatar] fetch failed: timed out\n"
        );
    }
}
