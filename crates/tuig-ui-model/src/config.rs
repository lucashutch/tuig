//! The `tuig` configuration directory shared by the layout, session, and theme files.

use std::path::PathBuf;

/// `$XDG_CONFIG_HOME/tuig`, or `~/.config/tuig` when the variable is unset or empty.
pub fn config_root() -> PathBuf {
    config_root_from(std::env::var("XDG_CONFIG_HOME").ok().as_deref())
}

/// Same as [`config_root`] with the `XDG_CONFIG_HOME` value passed in.
pub fn config_root_from(xdg_config_home: Option<&str>) -> PathBuf {
    let home = match xdg_config_home {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            home.join(".config")
        }
    };
    home.join("tuig")
}

/// A sibling temporary path for write-then-rename saves.
pub(crate) fn temporary_name() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{nanos:x}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// A fresh directory under the system temp directory, for tests.
#[cfg(test)]
pub(crate) fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tuig-ui-model-{label}-{}", temporary_name()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_a_nonempty_xdg_directory() {
        assert_eq!(
            config_root_from(Some("/config")),
            PathBuf::from("/config/tuig")
        );
        assert!(config_root_from(Some("")).ends_with(".config/tuig"));
        assert!(config_root_from(None).ends_with(".config/tuig"));
    }
}
