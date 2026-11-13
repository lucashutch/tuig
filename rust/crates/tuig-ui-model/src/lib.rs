//! UI logic for tuig that does not render: pure functions and state types.
//!
//! This crate ports parts of `src/ui/` from the TypeScript implementation.

pub mod bounded_cache;
pub mod changes_layout;
pub mod color;
pub mod command_palette;
pub mod composer;
pub mod config;
pub mod diff_lines;
pub mod diff_policy;
pub mod file_tree;
pub mod graph;
pub mod graph_index;
pub mod graph_menu;
pub mod graph_viewport;
pub mod history_columns;
pub mod history_viewport;
pub mod icon_theme;
pub mod preferences;
pub mod repository_tabs;
pub mod runtime_layout;
pub mod scrollbar;
pub mod search;
pub mod session_preferences;
pub mod sidebar;
pub mod text_width;
pub mod theme;
pub mod theme_resolver;
pub mod theme_store;
pub mod themes;
pub mod toolbar;
