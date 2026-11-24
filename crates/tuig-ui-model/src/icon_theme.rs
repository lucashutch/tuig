//! Material icon lookup for file and folder names. The data is `assets/icons/material-icons.json`,
//! the same file the TypeScript app reads.

use crate::color::Rgba;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedIcon {
    pub glyph: String,
    pub color: Option<Rgba>,
}

struct MaterialIcons {
    file: ResolvedIcon,
    folder: ResolvedIcon,
    folder_open: ResolvedIcon,
    definitions: HashMap<String, ResolvedIcon>,
    names: HashMap<String, String>,
    extensions: HashMap<String, String>,
}

fn icon(value: &Value) -> Option<ResolvedIcon> {
    Some(ResolvedIcon {
        glyph: value.get("glyph")?.as_str()?.to_string(),
        color: value
            .get("color")
            .and_then(Value::as_str)
            .and_then(Rgba::parse),
    })
}

fn string_map(value: &Value) -> HashMap<String, String> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, id)| Some((key.clone(), id.as_str()?.to_string())))
        .collect()
}

fn material() -> &'static MaterialIcons {
    static MATERIAL: OnceLock<MaterialIcons> = OnceLock::new();
    MATERIAL.get_or_init(|| {
        let document: Value =
            serde_json::from_str(include_str!("../../../assets/icons/material-icons.json"))
                .expect("material-icons.json is valid JSON");
        let data = &document["icons"][0];
        let required = |key: &str| {
            icon(&data[key]).unwrap_or_else(|| panic!("material icon {key} is missing"))
        };
        MaterialIcons {
            file: required("file"),
            folder: required("folder"),
            folder_open: required("folderOpen"),
            definitions: data["definitions"]
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(id, value)| Some((id.clone(), icon(value)?)))
                .collect(),
            names: string_map(&data["names"]),
            extensions: string_map(&data["extensions"]),
        }
    })
}

fn definition(id: Option<&String>, fallback: &ResolvedIcon) -> ResolvedIcon {
    id.and_then(|id| material().definitions.get(id))
        .unwrap_or(fallback)
        .clone()
}

/// Icon for a file or folder name. Names match first, then the longest dotted extension, then
/// the generic file icon. Folders always use the generic folder glyph, because name-specific
/// folder icons read as file-type icons in a dense tree.
pub fn resolve_material_icon(name: &str, directory: bool, open: bool) -> ResolvedIcon {
    let material = material();
    if directory {
        return if open {
            material.folder_open.clone()
        } else {
            material.folder.clone()
        };
    }
    let lower = name.to_lowercase();
    if let Some(id) = material.names.get(&lower).filter(|id| !id.is_empty()) {
        return definition(Some(id), &material.file);
    }
    let parts: Vec<&str> = lower.split('.').collect();
    for index in 1..parts.len() {
        if let Some(id) = material
            .extensions
            .get(&parts[index..].join("."))
            .filter(|id| !id.is_empty())
        {
            return definition(Some(id), &material.file);
        }
    }
    material.file.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_filename_associations_before_extensions() {
        assert_ne!(
            resolve_material_icon("package.json", false, false),
            resolve_material_icon("unknown.json", false, false)
        );
    }

    #[test]
    fn matches_the_longest_extension_and_is_case_insensitive() {
        assert_eq!(
            resolve_material_icon("PACKAGE.JSON", false, false),
            resolve_material_icon("package.json", false, false)
        );
        assert_eq!(
            resolve_material_icon("x.no-such-ext", false, false),
            resolve_material_icon("plain", false, false)
        );
    }

    #[test]
    fn distinguishes_open_and_closed_generic_folders() {
        assert_ne!(
            resolve_material_icon("unknown-folder", true, false).glyph,
            resolve_material_icon("unknown-folder", true, true).glyph
        );
    }
}
