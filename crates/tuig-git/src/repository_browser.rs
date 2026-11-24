//! Directory completion for the repository picker. Port of
//! `src/git/repository-browser.ts`.
//!
//! Differences from the TypeScript code:
//! - Callers pass `cwd` explicitly instead of defaulting to the process directory.
//! - Names sort by lowercase text, then lowercase before uppercase. The
//!   TypeScript code uses ICU `localeCompare`, which also folds accents.

use std::cmp::Ordering;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// A visible child directory that can be displayed and selected by a picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectorySuggestion {
    pub name: String,
    /// Absolute path to the directory, ready for opening.
    pub path: PathBuf,
}

/// Resolve `path` against `base` and normalize `.` and `..` without touching
/// the file system, like Node's `path.resolve`.
fn resolve(base: &Path, path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    for component in joined.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => out.push(component),
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` at the root stays at the root.
                if out.parent().is_some() {
                    out.pop();
                }
            }
            Component::Normal(name) => out.push(name),
        }
    }
    out
}

/// Resolve picker input, including the shell-style home directory shorthand.
pub fn resolve_repository_path(typed_path: &str, cwd: &Path, home: &Path) -> PathBuf {
    if typed_path == "~" {
        return resolve(Path::new("/"), home);
    }
    if let Some(rest) = typed_path.strip_prefix("~/") {
        return resolve(home, Path::new(rest));
    }
    resolve(cwd, Path::new(typed_path))
}

fn sort_directory_names(left: &str, right: &str) -> Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        // Lowercase sorts before uppercase for names that differ only in case.
        .then_with(|| right.cmp(left))
}

/// Resolve the directory being completed and the partial final path component.
/// A trailing separator means the complete path names the directory to inspect;
/// otherwise its parent is inspected and its basename is the filter.
fn completion_location(typed_path: &str, cwd: &Path) -> (PathBuf, String) {
    if typed_path.is_empty() {
        return (resolve(cwd, Path::new("")), String::new());
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let absolute = resolve_repository_path(typed_path, cwd, &home);
    if typed_path.ends_with('/') {
        return (absolute, String::new());
    }
    let directory = absolute
        .parent()
        .map_or_else(|| absolute.clone(), Path::to_path_buf);
    let partial = absolute
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    (directory, partial)
}

/// List non-hidden child directories matching the final component of a path.
///
/// `typed_path` may be absolute or relative to `cwd`. Missing and unreadable
/// parents produce no suggestions, which keeps an in-progress path edit from
/// turning a picker into an error state. A symlink to a directory is not
/// listed, which matches the TypeScript `Dirent.isDirectory()` check.
pub fn suggest_directories(typed_path: &str, cwd: &Path) -> Vec<DirectorySuggestion> {
    let cwd = resolve(Path::new("/"), cwd);
    let (directory, partial) = completion_location(typed_path, &cwd);
    let wanted = partial.to_lowercase();
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut found: Vec<(String, OsString)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let raw = entry.file_name();
            let name = raw.to_string_lossy().into_owned();
            (!name.starts_with('.') && name.to_lowercase().starts_with(&wanted))
                .then_some((name, raw))
        })
        .collect();
    found.sort_by(|left, right| sort_directory_names(&left.0, &right.0));
    found
        .into_iter()
        .map(|(name, raw)| DirectorySuggestion {
            name,
            path: directory.join(raw),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::TempDir;
    use std::fs;

    fn suggestion(dir: &Path, parts: &[&str]) -> DirectorySuggestion {
        let mut path = dir.to_path_buf();
        path.extend(parts);
        DirectorySuggestion {
            name: parts.last().unwrap().to_string(),
            path,
        }
    }

    #[test]
    fn lists_sorted_non_hidden_child_directories_and_ignores_files() {
        let cwd = TempDir::new("tuig-browser");
        for dir in ["zulu", "Alpha", ".cache"] {
            fs::create_dir(cwd.path().join(dir)).unwrap();
        }
        fs::write(cwd.path().join("notes.txt"), "not a directory").unwrap();

        assert_eq!(
            suggest_directories("", cwd.path()),
            vec![
                suggestion(cwd.path(), &["Alpha"]),
                suggestion(cwd.path(), &["zulu"]),
            ]
        );
    }

    #[test]
    fn filters_the_basename_case_insensitively_for_relative_and_absolute_paths() {
        let cwd = TempDir::new("tuig-browser");
        fs::create_dir_all(cwd.path().join("Projects/Nested")).unwrap();
        fs::create_dir(cwd.path().join("Profiles")).unwrap();

        assert_eq!(
            suggest_directories("pr", cwd.path()),
            vec![
                suggestion(cwd.path(), &["Profiles"]),
                suggestion(cwd.path(), &["Projects"]),
            ]
        );
        let absolute = cwd.path().join("Projects").join("nEs");
        assert_eq!(
            suggest_directories(absolute.to_str().unwrap(), cwd.path()),
            vec![suggestion(cwd.path(), &["Projects", "Nested"])]
        );
    }
}
