//! Open repository tabs, stored at `<config>/tuig/session.json` and shared with the
//! TypeScript app.

use crate::config::config_root;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const MAX_RECENT_REPOSITORIES: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmoduleRelation {
    pub root: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionPreferences {
    pub repositories: Vec<String>,
    pub active_repository: Option<String>,
    /// Submodule tab path to its parent repository, keyed by the submodule's repository path.
    pub submodules: Option<BTreeMap<String, SubmoduleRelation>>,
    pub recent_repositories: Option<Vec<String>>,
}

pub fn promote_recent_repository(recent: &[String], root: &str) -> Vec<String> {
    std::iter::once(root.to_string())
        .chain(recent.iter().filter(|path| path.as_str() != root).cloned())
        .filter(|path| !path.is_empty())
        .take(MAX_RECENT_REPOSITORIES)
        .collect()
}

pub fn remove_recent_repository(recent: &[String], root: &str) -> Vec<String> {
    recent
        .iter()
        .filter(|path| path.as_str() != root)
        .cloned()
        .collect()
}

pub fn session_preferences_path() -> PathBuf {
    config_root().join("session.json")
}

/// Nonempty strings from a JSON array, without duplicates, in first-seen order.
fn unique_paths(value: &Value) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for item in value.as_array().into_iter().flatten() {
        if let Some(path) = item.as_str().filter(|p| !p.is_empty())
            && !seen.iter().any(|existing| existing == path)
        {
            seen.push(path.to_string());
        }
    }
    seen
}

pub fn parse_session_preferences(value: &Value) -> SessionPreferences {
    let Some(input) = value.as_object() else {
        return SessionPreferences::default();
    };
    let repositories = input
        .get("repositories")
        .map(unique_paths)
        .unwrap_or_default();
    let recent_repositories = input
        .get("recentRepositories")
        .filter(|v| v.is_array())
        .map(|v| {
            let mut paths = unique_paths(v);
            paths.truncate(MAX_RECENT_REPOSITORIES);
            paths
        });
    let active_repository = input
        .get("activeRepository")
        .and_then(Value::as_str)
        .filter(|active| repositories.iter().any(|r| r == active))
        .map(str::to_string);
    let submodules: BTreeMap<String, SubmoduleRelation> = input
        .get("submodules")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(repository, _)| repositories.iter().any(|r| r == *repository))
        .filter_map(|(repository, relation)| {
            let relation = relation.as_object()?;
            Some((
                repository.clone(),
                SubmoduleRelation {
                    root: relation.get("root")?.as_str()?.to_string(),
                    path: relation.get("path")?.as_str()?.to_string(),
                },
            ))
        })
        .collect();
    SessionPreferences {
        repositories,
        active_repository,
        submodules: (!submodules.is_empty()).then_some(submodules),
        recent_repositories,
    }
}

/// Load the session. A missing or malformed file gives an empty session.
pub fn load_session_preferences(path: &Path) -> SessionPreferences {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|value| parse_session_preferences(&value))
        .unwrap_or_default()
}

impl SessionPreferences {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("repositories".into(), strings(&self.repositories));
        if let Some(active) = &self.active_repository {
            map.insert("activeRepository".into(), Value::String(active.clone()));
        }
        if let Some(submodules) = &self.submodules {
            let object = submodules
                .iter()
                .map(|(key, relation)| {
                    let mut entry = Map::new();
                    entry.insert("root".into(), Value::String(relation.root.clone()));
                    entry.insert("path".into(), Value::String(relation.path.clone()));
                    (key.clone(), Value::Object(entry))
                })
                .collect();
            map.insert("submodules".into(), Value::Object(object));
        }
        if let Some(recent) = &self.recent_repositories {
            map.insert("recentRepositories".into(), strings(recent));
        }
        Value::Object(map)
    }
}

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

/// Replace the file with these preferences.
pub fn save_session_preferences(
    preferences: &SessionPreferences,
    path: &Path,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut text =
        serde_json::to_string_pretty(&preferences.to_json()).map_err(std::io::Error::other)?;
    text.push('\n');
    std::fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paths(count: usize) -> Vec<String> {
        (0..count).map(|i| format!("/repo-{i}")).collect()
    }

    #[test]
    fn keeps_unique_repository_paths_and_a_valid_active_repository() {
        let parsed = parse_session_preferences(&json!({
            "repositories": ["/one", "/two", "/one", 3], "activeRepository": "/two"
        }));
        assert_eq!(parsed.repositories, ["/one", "/two"]);
        assert_eq!(parsed.active_repository.as_deref(), Some("/two"));
        let parsed = parse_session_preferences(&json!({
            "repositories": ["/one"], "activeRepository": "/missing"
        }));
        assert_eq!(parsed.active_repository, None);
    }

    #[test]
    fn keeps_valid_submodule_tab_relationships() {
        let parsed = parse_session_preferences(&json!({
            "repositories": ["/parent", "/parent/sub"],
            "submodules": {
                "/parent/sub": { "root": "/parent", "path": "sub" },
                "/missing": { "root": "/parent", "path": "missing" },
                "/parent": { "root": 3, "path": "bad" }
            }
        }));
        let expected = BTreeMap::from([(
            "/parent/sub".to_string(),
            SubmoduleRelation {
                root: "/parent".into(),
                path: "sub".into(),
            },
        )]);
        assert_eq!(parsed.submodules, Some(expected));
    }

    #[test]
    fn keeps_at_most_20_unique_nonempty_recent_paths_in_order() {
        let all = paths(25);
        let mut input = vec![json!(""), json!("/repo-0"), json!(42)];
        input.extend(all.iter().map(|p| json!(p)));
        let parsed =
            parse_session_preferences(&json!({ "repositories": [], "recentRepositories": input }));
        assert_eq!(parsed.recent_repositories, Some(all[..20].to_vec()));
        // An empty list is kept, an absent key stays absent.
        let parsed = parse_session_preferences(&json!({ "recentRepositories": [] }));
        assert_eq!(parsed.recent_repositories, Some(vec![]));
        assert_eq!(
            parse_session_preferences(&json!({})).recent_repositories,
            None
        );
    }

    #[test]
    fn promotes_a_successful_root_and_removes_a_stale_root() {
        let recent = paths(20);
        let promoted = promote_recent_repository(&recent, "/repo-3");
        assert_eq!(promoted[0], "/repo-3");
        assert_eq!(promoted.len(), 20);
        assert_eq!(promoted.iter().filter(|p| *p == "/repo-3").count(), 1);
        let promoted = promote_recent_repository(&recent, "/new");
        assert_eq!(
            promoted[..],
            [vec!["/new".to_string()], recent[..19].to_vec()].concat()[..]
        );
        assert_eq!(remove_recent_repository(&recent, "/repo-3").len(), 19);
    }

    /// Written by `saveSessionPreferences` in the TypeScript app.
    const TS_FILE: &str = r#"{
  "repositories": [
    "/work/app",
    "/work/app/vendor/lib"
  ],
  "activeRepository": "/work/app/vendor/lib",
  "submodules": {
    "/work/app/vendor/lib": {
      "root": "/work/app",
      "path": "vendor/lib"
    }
  },
  "recentRepositories": [
    "/work/app",
    "/old/repo"
  ]
}
"#;

    #[test]
    fn round_trips_a_file_written_by_the_typescript_app() {
        let dir = std::env::temp_dir().join(format!(
            "tuig-ui-model-session-{}",
            crate::config::temporary_name()
        ));
        let path = dir.join("tuig").join("session.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, TS_FILE).unwrap();
        let loaded = load_session_preferences(&path);
        assert_eq!(
            loaded.active_repository.as_deref(),
            Some("/work/app/vendor/lib")
        );
        assert_eq!(loaded.recent_repositories.as_ref().unwrap().len(), 2);
        save_session_preferences(&loaded, &path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TS_FILE);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
