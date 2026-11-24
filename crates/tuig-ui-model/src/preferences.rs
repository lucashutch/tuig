//! Saved layout preferences, stored at `<config>/tuig/layout.json`.
//!
//! The file is shared with the TypeScript app. Parsing is lenient per field: an invalid value
//! becomes `None` and the other fields stay. Saving merges the defined fields into the stored
//! object, so keys this crate does not manage survive.

use crate::config::{config_root, temporary_name};
use serde_json::{Map, Number, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_SAVED_WIDTH: f64 = 1000.0;

/// Saved history column layout. Widths are cells and clamp to the pane on use.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryColumnPreferences {
    pub branch_width: Option<u32>,
    pub graph_width: Option<u32>,
    pub committer_width: Option<u32>,
    pub show_committer: Option<bool>,
    pub show_sha: Option<bool>,
    pub show_pr: Option<bool>,
}

/// One value per sidebar section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarSections<T> {
    pub local: Option<T>,
    pub pull_requests: Option<T>,
    pub remote: Option<T>,
    pub submodules: Option<T>,
    pub stashes: Option<T>,
    pub worktrees: Option<T>,
}

impl<T> Default for SidebarSections<T> {
    fn default() -> Self {
        Self {
            local: None,
            pull_requests: None,
            remote: None,
            submodules: None,
            stashes: None,
            worktrees: None,
        }
    }
}

/// JSON keys of the sidebar sections, in the order the TypeScript app writes them.
pub const SIDEBAR_SECTION_KEYS: [&str; 6] = [
    "local",
    "pullRequests",
    "remote",
    "submodules",
    "stashes",
    "worktrees",
];

impl<T> SidebarSections<T> {
    fn from_fn(mut read: impl FnMut(&str) -> Option<T>) -> Self {
        Self {
            local: read("local"),
            pull_requests: read("pullRequests"),
            remote: read("remote"),
            submodules: read("submodules"),
            stashes: read("stashes"),
            worktrees: read("worktrees"),
        }
    }

    fn get(&self, key: &str) -> Option<&T> {
        match key {
            "local" => self.local.as_ref(),
            "pullRequests" => self.pull_requests.as_ref(),
            "remote" => self.remote.as_ref(),
            "submodules" => self.submodules.as_ref(),
            "stashes" => self.stashes.as_ref(),
            "worktrees" => self.worktrees.as_ref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffView {
    Inline,
    SideBySide,
}

impl DiffView {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inline => "inline",
            Self::SideBySide => "side-by-side",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LayoutPreferences {
    /// Whether remote author avatars may be fetched and displayed.
    pub avatars_enabled: Option<bool>,
    /// Preferred diff layout. Narrow panes can temporarily fall back to inline.
    pub diff_view: Option<DiffView>,
    /// Minutes between automatic `git fetch --prune` runs. Zero disables it.
    pub remote_fetch_interval_minutes: Option<f64>,
    pub left_width: Option<f64>,
    pub details_width: Option<f64>,
    pub left_collapsed: Option<bool>,
    pub details_collapsed: Option<bool>,
    pub history_columns: Option<HistoryColumnPreferences>,
    pub unstaged_height: Option<f64>,
    pub composer_height: Option<f64>,
    pub sidebar_heights: Option<SidebarSections<f64>>,
    pub sidebar_collapsed: Option<SidebarSections<bool>>,
    /// Git directories of repositories whose "write a commit-graph" notice was shown. It is not shown again.
    pub commit_graph_hint_dismissed: Option<Vec<String>>,
}

pub fn layout_preferences_path() -> PathBuf {
    config_root().join("layout.json")
}

/// What `typeof value === "object" && value` accepts in the TypeScript parser, which includes
/// arrays. Arrays have no named members, so every lookup in them misses.
fn is_object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

fn member<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn non_negative(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

fn flag(value: Option<&Value>) -> Option<bool> {
    value?.as_bool()
}

fn column_width(value: Option<&Value>) -> Option<u32> {
    let number = value?.as_f64()?;
    (number.is_finite() && (1.0..=MAX_SAVED_WIDTH).contains(&number))
        // `Math.round` rounds halves up. The value is positive, so this matches.
        .then(|| (number + 0.5).floor() as u32)
}

pub fn parse_layout_preferences(value: &Value) -> LayoutPreferences {
    if !is_object_like(Some(value)) {
        return LayoutPreferences::default();
    }
    let get = |key: &str| value.as_object().and_then(|object| object.get(key));
    let columns = get("historyColumns");
    let history_columns = is_object_like(columns).then(|| HistoryColumnPreferences {
        branch_width: column_width(member(columns, "branchWidth")),
        graph_width: column_width(member(columns, "graphWidth")),
        committer_width: column_width(member(columns, "committerWidth")),
        show_committer: flag(member(columns, "showCommitter")),
        show_sha: flag(member(columns, "showSha")),
        show_pr: flag(member(columns, "showPr")),
    });
    let heights = get("sidebarHeights");
    let sidebar_heights = is_object_like(heights)
        .then(|| SidebarSections::from_fn(|section| non_negative(member(heights, section))));
    let collapsed = get("sidebarCollapsed");
    let sidebar_collapsed = is_object_like(collapsed)
        .then(|| SidebarSections::from_fn(|section| flag(member(collapsed, section))));
    LayoutPreferences {
        avatars_enabled: flag(get("avatarsEnabled")),
        diff_view: match get("diffView").and_then(Value::as_str) {
            Some("inline") => Some(DiffView::Inline),
            Some("side-by-side") => Some(DiffView::SideBySide),
            _ => None,
        },
        remote_fetch_interval_minutes: non_negative(get("remoteFetchIntervalMinutes")),
        left_width: non_negative(get("leftWidth")),
        details_width: non_negative(get("detailsWidth")),
        left_collapsed: flag(get("leftCollapsed")),
        details_collapsed: flag(get("detailsCollapsed")),
        history_columns,
        unstaged_height: non_negative(get("unstagedHeight")),
        composer_height: non_negative(get("composerHeight")),
        sidebar_heights,
        sidebar_collapsed,
        commit_graph_hint_dismissed: get("commitGraphHintDismissed")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            }),
    }
}

/// Load the preferences. A missing or malformed file gives the defaults.
pub fn load_layout_preferences(path: &Path) -> LayoutPreferences {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| parse_layout_preferences(&value))
        .unwrap_or_default()
}

/// Write an integral number without a fractional part, like `JSON.stringify` does.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

fn sections_to_json<T>(sections: &SidebarSections<T>, convert: impl Fn(&T) -> Value) -> Value {
    let mut map = Map::new();
    for key in SIDEBAR_SECTION_KEYS {
        if let Some(value) = sections.get(key) {
            map.insert(key.to_string(), convert(value));
        }
    }
    Value::Object(map)
}

impl LayoutPreferences {
    /// The defined fields as a JSON object. Undefined fields are left out, like
    /// `JSON.stringify` leaves out `undefined`.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut map = Map::new();
        let mut put = |key: &str, value: Option<Value>| {
            if let Some(value) = value {
                map.insert(key.to_string(), value);
            }
        };
        put("avatarsEnabled", self.avatars_enabled.map(Value::Bool));
        put(
            "diffView",
            self.diff_view.map(|v| Value::String(v.as_str().into())),
        );
        put(
            "remoteFetchIntervalMinutes",
            self.remote_fetch_interval_minutes.map(number),
        );
        put("leftWidth", self.left_width.map(number));
        put("detailsWidth", self.details_width.map(number));
        put("leftCollapsed", self.left_collapsed.map(Value::Bool));
        put("detailsCollapsed", self.details_collapsed.map(Value::Bool));
        put(
            "historyColumns",
            self.history_columns.as_ref().map(|c| {
                let mut map = Map::new();
                for (key, width) in [
                    ("branchWidth", c.branch_width),
                    ("graphWidth", c.graph_width),
                    ("committerWidth", c.committer_width),
                ] {
                    if let Some(width) = width {
                        map.insert(key.into(), Value::Number(width.into()));
                    }
                }
                for (key, show) in [
                    ("showCommitter", c.show_committer),
                    ("showSha", c.show_sha),
                    ("showPr", c.show_pr),
                ] {
                    if let Some(show) = show {
                        map.insert(key.into(), Value::Bool(show));
                    }
                }
                Value::Object(map)
            }),
        );
        put("unstagedHeight", self.unstaged_height.map(number));
        put("composerHeight", self.composer_height.map(number));
        put(
            "sidebarHeights",
            self.sidebar_heights
                .as_ref()
                .map(|s| sections_to_json(s, |v| number(*v))),
        );
        put(
            "sidebarCollapsed",
            self.sidebar_collapsed
                .as_ref()
                .map(|s| sections_to_json(s, |v| Value::Bool(*v))),
        );
        put(
            "commitGraphHintDismissed",
            self.commit_graph_hint_dismissed
                .as_ref()
                .map(|items| Value::Array(items.iter().cloned().map(Value::String).collect())),
        );
        map
    }
}

/// Saves go through one lock, so concurrent saves in this process cannot interleave their
/// read-modify-write cycles.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Merge the defined preferences into the existing file. Keys this crate does not manage, and
/// keys left `None`, keep their stored values. A nested value replaces the stored one as a
/// whole. The write goes to a temporary file first so a crash cannot leave a truncated file.
pub fn save_layout_preferences(
    preferences: &LayoutPreferences,
    path: &Path,
) -> std::io::Result<()> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut merged = match std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
    {
        Some(Value::Object(existing)) => existing,
        // A missing or malformed file is replaced.
        _ => Map::new(),
    };
    for (key, value) in preferences.to_json() {
        merged.insert(key, value);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text =
        serde_json::to_string_pretty(&Value::Object(merged)).map_err(std::io::Error::other)?;
    text.push('\n');
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), temporary_name()));
    let result = std::fs::write(&temporary, text).and_then(|()| std::fs::rename(&temporary, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::temp_dir;
    use serde_json::json;

    #[test]
    fn keeps_valid_dimensions_and_ignores_corrupt_values() {
        let parsed = parse_layout_preferences(&json!({
            "leftWidth": 31, "detailsWidth": 52, "unstagedHeight": 0, "composerHeight": -4,
            "remoteFetchIntervalMinutes": -1, "avatarsEnabled": "no", "diffView": "grid"
        }));
        assert_eq!(
            parsed,
            LayoutPreferences {
                left_width: Some(31.0),
                details_width: Some(52.0),
                unstaged_height: Some(0.0),
                ..Default::default()
            }
        );
        assert_eq!(
            parse_layout_preferences(&json!("invalid")),
            LayoutPreferences::default()
        );
        let parsed = parse_layout_preferences(&json!({
            "avatarsEnabled": false, "diffView": "side-by-side", "remoteFetchIntervalMinutes": 15
        }));
        assert_eq!(parsed.avatars_enabled, Some(false));
        assert_eq!(parsed.diff_view, Some(DiffView::SideBySide));
        assert_eq!(parsed.remote_fetch_interval_minutes, Some(15.0));
    }

    #[test]
    fn falls_back_per_field_for_invalid_history_column_values() {
        let parsed = parse_layout_preferences(&json!({
            "leftCollapsed": "yes", "detailsCollapsed": true,
            "historyColumns": {
                "branchWidth": -3, "graphWidth": 12.4, "committerWidth": 1e9,
                "showCommitter": "no", "showSha": false
            }
        }));
        assert_eq!(parsed.left_collapsed, None);
        assert_eq!(parsed.details_collapsed, Some(true));
        assert_eq!(
            parsed.history_columns,
            Some(HistoryColumnPreferences {
                graph_width: Some(12),
                show_sha: Some(false),
                ..Default::default()
            })
        );
        assert_eq!(
            parse_layout_preferences(&json!({ "historyColumns": 5 })).history_columns,
            None
        );
    }

    /// Written by `saveLayoutPreferences` in the TypeScript app.
    const TS_FILE: &str = r#"{
  "remoteFetchIntervalMinutes": 15,
  "futureSetting": {
    "a": 1
  },
  "avatarsEnabled": false,
  "diffView": "side-by-side",
  "leftWidth": 33,
  "detailsWidth": 50,
  "leftCollapsed": true,
  "detailsCollapsed": false,
  "historyColumns": {
    "branchWidth": 18,
    "graphWidth": 12,
    "committerWidth": 9,
    "showCommitter": false,
    "showSha": true
  },
  "unstagedHeight": 7,
  "sidebarHeights": {
    "local": 8,
    "stashes": 3
  },
  "sidebarCollapsed": {
    "remote": true
  }
}
"#;

    #[test]
    fn reads_a_file_written_by_the_typescript_app_and_keeps_its_unknown_keys() {
        let dir = temp_dir("layout-ts");
        let path = dir.join("tuig").join("layout.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, TS_FILE).unwrap();

        let loaded = load_layout_preferences(&path);
        assert_eq!(loaded.left_width, Some(33.0));
        assert_eq!(loaded.left_collapsed, Some(true));
        assert_eq!(loaded.diff_view, Some(DiffView::SideBySide));
        assert_eq!(
            loaded.history_columns.as_ref().unwrap().committer_width,
            Some(9)
        );
        assert_eq!(loaded.sidebar_heights.as_ref().unwrap().stashes, Some(3.0));
        assert_eq!(
            loaded.sidebar_collapsed.as_ref().unwrap().remote,
            Some(true)
        );

        // Saving an unchanged copy reproduces the TypeScript file byte for byte, except that
        // it keeps unknown keys in place.
        save_layout_preferences(&loaded, &path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TS_FILE);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn round_trips_changes_pane_heights_and_diff_view_in_the_typescript_layout() {
        let dir = temp_dir("layout-changes");
        let path = dir.join("layout.json");
        std::fs::write(
            &path,
            r#"{"unstagedHeight":8,"composerHeight":9,"diffView":"inline","avatarsEnabled":false}"#,
        )
        .unwrap();
        let loaded = load_layout_preferences(&path);
        assert_eq!(loaded.unstaged_height, Some(8.0));
        assert_eq!(loaded.composer_height, Some(9.0));
        assert_eq!(loaded.diff_view, Some(DiffView::Inline));
        let update = LayoutPreferences {
            diff_view: Some(DiffView::SideBySide),
            ..loaded
        };
        save_layout_preferences(&update, &path).unwrap();
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            stored,
            json!({"unstagedHeight":8,"composerHeight":9,"diffView":"side-by-side","avatarsEnabled":false})
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn save_merges_defined_fields_and_replaces_nested_objects_whole() {
        let dir = temp_dir("layout-merge");
        let path = dir.join("tuig").join("layout.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"remoteFetchIntervalMinutes":15,"futureSetting":{"a":1},"leftWidth":20,
               "sidebarHeights":{"local":4,"stashes":9}}"#,
        )
        .unwrap();
        let update = LayoutPreferences {
            left_width: Some(40.0),
            sidebar_heights: Some(SidebarSections {
                local: Some(6.0),
                ..Default::default()
            }),
            ..Default::default()
        };
        save_layout_preferences(&update, &path).unwrap();
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            stored,
            json!({
                "remoteFetchIntervalMinutes": 15,
                "futureSetting": { "a": 1 },
                "leftWidth": 40,
                "sidebarHeights": { "local": 6 }
            })
        );
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["layout.json"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_a_malformed_file_and_loads_defaults_from_it() {
        let dir = temp_dir("layout-bad");
        let path = dir.join("layout.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load_layout_preferences(&path), LayoutPreferences::default());
        let saved = LayoutPreferences {
            left_width: Some(30.0),
            ..Default::default()
        };
        save_layout_preferences(&saved, &path).unwrap();
        assert_eq!(load_layout_preferences(&path), saved);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
