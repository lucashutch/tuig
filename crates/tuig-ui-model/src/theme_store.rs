//! Theme selection file and theme discovery.
//!
//! The selection lives at `<config>/tuig/theme.json`. Custom themes load from
//! `<config>/tuig/themes/*.json`, then from `.tuig/themes/*.json` in each ancestor directory of
//! the repository, outermost first, so the repository's own directory wins.

use crate::config::{config_root, temporary_name};
use crate::theme::{Theme, one_dark_theme};
use crate::theme_resolver::{ThemeError, ThemeMode, theme_from_document};
use crate::themes::{builtin_theme_documents, opencode_document};
use serde_json::Value;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// The mode a user selected. `System` follows the terminal's light or dark setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeModeSelection {
    Dark,
    Light,
    System,
}

impl ThemeModeSelection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeSelection {
    pub name: String,
    pub mode: ThemeModeSelection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeEntry {
    pub name: String,
    pub source: String,
}

/// A theme name is a file name: not empty, not `.` or `..`, no path separators, no control
/// characters.
pub fn validate_name(name: &str) -> Result<(), ThemeError> {
    let invalid = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\'])
        || name
            .chars()
            .any(|c| (c as u32) < 32 || (127..=159).contains(&(c as u32)));
    if invalid {
        Err(ThemeError(
            "Invalid theme name: use a filename without paths or control characters".into(),
        ))
    } else {
        Ok(())
    }
}

fn selection(value: &Value) -> Result<ThemeSelection, ThemeError> {
    if !value.is_object() && !value.is_array() {
        return Err(ThemeError(
            "Invalid theme preferences: expected name and mode".into(),
        ));
    }
    let name = value.get("name").and_then(Value::as_str).unwrap_or("");
    validate_name(name)?;
    let mode = match value.get("mode").and_then(Value::as_str) {
        Some("dark") => ThemeModeSelection::Dark,
        Some("light") => ThemeModeSelection::Light,
        Some("system") => ThemeModeSelection::System,
        _ => {
            return Err(ThemeError(
                "Invalid theme mode: expected dark, light, or system".into(),
            ));
        }
    };
    Ok(ThemeSelection {
        name: name.to_string(),
        mode,
    })
}

/// Load the saved selection. A missing file gives `one-dark` with the system mode.
pub fn load_theme_preferences_from(root: &Path) -> Result<ThemeSelection, ThemeError> {
    let cannot = |error: String| ThemeError(format!("Cannot load theme preferences: {error}"));
    match std::fs::read_to_string(root.join("theme.json")) {
        Ok(text) => {
            let value = serde_json::from_str::<Value>(&text).map_err(|e| cannot(e.to_string()))?;
            selection(&value).map_err(|e| cannot(e.0))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(ThemeSelection {
            name: "one-dark".into(),
            mode: ThemeModeSelection::System,
        }),
        Err(error) => Err(cannot(error.to_string())),
    }
}

pub fn load_theme_preferences() -> Result<ThemeSelection, ThemeError> {
    load_theme_preferences_from(&config_root())
}

/// Save the selection with a temporary file and a rename, with mode 0600 on Unix.
pub fn save_theme_preferences_to(root: &Path, value: &ThemeSelection) -> Result<(), ThemeError> {
    validate_name(&value.name)?;
    let io = |error: std::io::Error| ThemeError(error.to_string());
    std::fs::create_dir_all(root).map_err(io)?;
    let mut text = serde_json::to_string_pretty(&serde_json::json!({
        "name": value.name,
        "mode": value.mode.as_str(),
    }))
    .map_err(|e| ThemeError(e.to_string()))?;
    text.push('\n');
    let temporary = root.join(format!(".theme-{}.tmp", temporary_name()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options
        .open(&temporary)
        .and_then(|mut file| std::io::Write::write_all(&mut file, text.as_bytes()))
        .and_then(|()| std::fs::rename(&temporary, root.join("theme.json")));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map_err(io)
}

pub fn save_theme_preferences(value: &ThemeSelection) -> Result<(), ThemeError> {
    save_theme_preferences_to(&config_root(), value)
}

enum Source {
    /// The built-in default, which has no document.
    OneDark,
    Document(Value),
    Failed(String),
}

struct CatalogEntry {
    name: String,
    source: String,
    kind: Source,
}

pub struct ThemeCatalog {
    entries: Vec<CatalogEntry>,
    pub errors: Vec<String>,
}

/// `path.resolve`: make the path absolute and drop `.` and `..` components without touching the
/// file system.
fn resolve_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

impl ThemeCatalog {
    /// Names and sources in discovery order. Later directories replace earlier entries with the
    /// same name in place.
    pub fn entries(&self) -> Vec<ThemeEntry> {
        self.entries
            .iter()
            .map(|e| ThemeEntry {
                name: e.name.clone(),
                source: e.source.clone(),
            })
            .collect()
    }

    fn set(&mut self, name: String, source: String, kind: Source) {
        match self.entries.iter_mut().find(|e| e.name == name) {
            Some(entry) => {
                entry.source = source;
                entry.kind = kind;
            }
            None => self.entries.push(CatalogEntry { name, source, kind }),
        }
    }

    pub fn resolve(&self, name: &str, mode: ThemeMode) -> Result<Theme, ThemeError> {
        validate_name(name)?;
        let Some(entry) = self.entries.iter().find(|e| e.name == name) else {
            return Err(ThemeError(format!("Unknown theme: {name}")));
        };
        match &entry.kind {
            Source::Failed(message) => Err(ThemeError(message.clone())),
            Source::Document(document) => theme_from_document(document, mode),
            Source::OneDark => Ok(one_dark_theme()),
        }
    }
}

/// Load the built-in themes and the custom themes visible from `repository_root`.
pub fn load_theme_catalog(repository_root: Option<&Path>) -> ThemeCatalog {
    load_theme_catalog_from(&config_root(), repository_root)
}

pub fn load_theme_catalog_from(config: &Path, repository_root: Option<&Path>) -> ThemeCatalog {
    let mut catalog = ThemeCatalog {
        entries: Vec::new(),
        errors: Vec::new(),
    };
    catalog.set("one-dark".into(), "builtin".into(), Source::OneDark);
    catalog.set(
        "opencode".into(),
        "builtin".into(),
        Source::Document(opencode_document().clone()),
    );
    for (name, document) in builtin_theme_documents() {
        catalog.set(
            name.clone(),
            "builtin".into(),
            Source::Document(document.clone()),
        );
    }
    let mut directories = vec![config.join("themes")];
    if let Some(root) = repository_root {
        let mut ancestors = Vec::new();
        let mut current = resolve_path(root);
        loop {
            ancestors.push(current.join(".tuig").join("themes"));
            match current.parent() {
                Some(parent) => current = parent.to_path_buf(),
                None => break,
            }
        }
        ancestors.reverse();
        directories.extend(ancestors);
    }
    for directory in directories {
        let files = match std::fs::read_dir(&directory) {
            Ok(files) => files,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                catalog
                    .errors
                    .push(format!("{}: {error}", directory.display()));
                continue;
            }
        };
        let mut names: Vec<String> = files
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        // `Array.prototype.sort` orders by UTF-16 code units.
        names.sort_by_key(|name| name.encode_utf16().collect::<Vec<u16>>());
        for file in names {
            let Some(name) = file.strip_suffix(".json") else {
                continue;
            };
            let path = directory.join(&file);
            let source = path.display().to_string();
            let loaded = (|| -> Result<Value, String> {
                validate_name(name).map_err(|e| e.0)?;
                let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let document: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                theme_from_document(&document, ThemeMode::Dark).map_err(|e| e.0)?;
                theme_from_document(&document, ThemeMode::Light).map_err(|e| e.0)?;
                Ok(document)
            })();
            match loaded {
                Ok(document) => catalog.set(name.to_string(), source, Source::Document(document)),
                Err(error) => {
                    let message = format!("{source}: {error}");
                    catalog.errors.push(message.clone());
                    catalog.set(name.to_string(), source, Source::Failed(message));
                }
            }
        }
    }
    catalog
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::Rgba;
    use crate::config::temp_dir;
    use crate::theme::{Surface, ThemeStates, semantic_color};
    use serde_json::json;

    const PALETTES: &str = include_str!("../../../assets/themes/palettes.json");

    fn rgb(hex: &str) -> Rgba {
        Rgba::parse(hex).unwrap()
    }

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), text).unwrap();
    }

    fn fixture() -> Value {
        opencode_document().clone()
    }

    #[test]
    fn builtin_palettes_resolve_to_their_source_colors_in_both_modes() {
        let root = temp_dir("themes-builtin");
        let catalog = load_theme_catalog_from(&root, None);
        let palettes: Value = serde_json::from_str(PALETTES).unwrap();
        let none = ThemeStates::default();
        let focused = ThemeStates {
            focused: true,
            ..none
        };
        for (name, modes) in palettes.as_object().unwrap() {
            assert!(catalog.entries().contains(&ThemeEntry {
                name: name.clone(),
                source: "builtin".into()
            }));
            for (mode, tag) in [(ThemeMode::Dark, "dark"), (ThemeMode::Light, "light")] {
                let palette = &modes[tag];
                let want = |key: &str| rgb(palette[key].as_str().unwrap());
                let theme = catalog.resolve(name, mode).unwrap();
                let at = |path: &str, surface, states| {
                    semantic_color(&theme, path, Rgba::TRANSPARENT, surface, states)
                };
                assert_eq!(theme.bg, want("background"), "{name} {tag}");
                assert_eq!(theme.text, want("text"), "{name} {tag}");
                assert_eq!(
                    at("syntax.keyword", Surface::Default, none),
                    want("syntaxKeyword"),
                    "{name} {tag}"
                );
                assert_eq!(
                    at("background.base", Surface::Dialog, none),
                    want("backgroundPanel"),
                    "{name} {tag}"
                );
                assert_eq!(
                    at("diff.highlight.added", Surface::Default, none),
                    want("diffHighlightAdded"),
                    "{name} {tag}"
                );
                assert_eq!(
                    at("text.action.primary", Surface::Default, focused),
                    want("background"),
                    "{name} {tag}"
                );
                assert!(!theme.graph.is_empty());
            }
        }
        assert_eq!(
            catalog.resolve("catppuccin", ThemeMode::Dark).unwrap().bg,
            rgb("#1e1e2e")
        );
        assert_eq!(
            catalog.resolve("one-dark", ThemeMode::Light).unwrap().bg,
            rgb("#282C34")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovers_ancestor_overrides_and_reports_bad_files() {
        let root = temp_dir("themes-discover");
        let config = root.join("config").join("tuig");
        let parent = root.join(".tuig").join("themes");
        let child = root.join("repo").join(".tuig").join("themes");
        let repo = root.join("repo");
        write(
            &config.join("themes"),
            "custom.json",
            &fixture().to_string(),
        );
        let mut override_doc = fixture();
        override_doc["base"]["border"]["base"] = json!("#123456");
        write(&parent, "custom.json", &override_doc.to_string());
        let border =
            |catalog: &ThemeCatalog| catalog.resolve("custom", ThemeMode::Dark).map(|t| t.border);
        assert_eq!(
            border(&load_theme_catalog_from(&config, Some(&repo))),
            Ok(rgb("#123456"))
        );

        // A broken file closer to the repository wins and reports its error.
        write(&child, "custom.json", "{bad");
        let catalog = load_theme_catalog_from(&config, Some(&repo));
        assert_eq!(catalog.errors.len(), 1);
        assert!(
            catalog
                .resolve("custom", ThemeMode::Dark)
                .unwrap_err()
                .0
                .contains("custom.json")
        );
        assert!(
            catalog
                .resolve("../custom", ThemeMode::Dark)
                .unwrap_err()
                .0
                .contains("Invalid theme name")
        );

        // A repository file replaces a builtin theme of the same name.
        let mut builtin_override = fixture();
        builtin_override["base"]["background"]["base"] = json!("#123456");
        write(&child, "tokyonight.json", &builtin_override.to_string());
        let catalog = load_theme_catalog_from(&config, Some(&repo));
        assert_eq!(
            catalog.resolve("tokyonight", ThemeMode::Dark).unwrap().bg,
            rgb("#123456")
        );

        // Names keep spaces and non-ASCII characters.
        write(&child, "Mon thème.v2.json", &fixture().to_string());
        assert!(
            load_theme_catalog_from(&config, Some(&repo))
                .resolve("Mon thème.v2", ThemeMode::Dark)
                .is_ok()
        );

        // Invalid documents fail at load, not at use.
        let mut empty_categories = fixture();
        empty_categories["base"]["categorical"] = json!([]);
        write(&child, "empty-category.json", &empty_categories.to_string());
        let mut missing_semantic = fixture();
        missing_semantic["dark"]["hue"] = json!({ "neutral": fixture()["dark"]["hue"]["gray"] });
        write(
            &child,
            "missing-semantic.json",
            &missing_semantic.to_string(),
        );
        let catalog = load_theme_catalog_from(&config, Some(&repo));
        assert!(
            catalog
                .resolve("empty-category", ThemeMode::Dark)
                .unwrap_err()
                .0
                .contains("categorical")
        );
        assert!(
            catalog
                .resolve("missing-semantic", ThemeMode::Dark)
                .unwrap_err()
                .0
                .contains("semantic hue")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_names_that_are_not_plain_file_names() {
        for invalid in ["", ".", "..", "a/b", "a\\b", "a\0b", "a\nb"] {
            assert!(validate_name(invalid).is_err(), "{invalid:?}");
        }
        assert!(validate_name("Mon thème.v2").is_ok());
    }

    #[test]
    fn theme_selection_round_trips_and_rejects_bad_modes() {
        let root = temp_dir("theme-selection");
        let selection = |name: &str, mode| ThemeSelection {
            name: name.into(),
            mode,
        };
        assert_eq!(
            load_theme_preferences_from(&root),
            Ok(selection("one-dark", ThemeModeSelection::System))
        );
        for saved in [
            selection("catppuccin", ThemeModeSelection::Light),
            selection("Mon thème.v2", ThemeModeSelection::System),
            selection("opencode", ThemeModeSelection::Dark),
        ] {
            save_theme_preferences_to(&root, &saved).unwrap();
            assert_eq!(load_theme_preferences_from(&root), Ok(saved));
        }
        // The file matches what the TypeScript app writes.
        assert_eq!(
            std::fs::read_to_string(root.join("theme.json")).unwrap(),
            "{\n  \"name\": \"opencode\",\n  \"mode\": \"dark\"\n}\n"
        );
        write(&root, "theme.json", r#"{"name":"opencode","mode":"bad"}"#);
        assert!(
            load_theme_preferences_from(&root)
                .unwrap_err()
                .0
                .contains("Invalid theme mode")
        );
        assert!(
            save_theme_preferences_to(&root, &selection("a/b", ThemeModeSelection::Dark)).is_err()
        );
        let leftovers = std::fs::read_dir(&root).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary files remain");
        std::fs::remove_dir_all(root).unwrap();
    }
}
