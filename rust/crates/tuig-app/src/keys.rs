//! Key bindings. Ports the part of `src/ui/runtime-keys.ts` that applies to the history pane.

use opentui::input::KeyEventKind;
use opentui::prelude::*;

/// What a key, palette entry or toolbar button asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Quit,
    /// Moves the history selection by rows (`moveCommit`).
    MoveCommit(i64),
    /// Pans the graph lanes by columns (`scrollGraphColumns`).
    ScrollGraph(i64),
    Refresh,
    /// Tab: moves focus between the history and changes panes.
    SwitchPane,
    /// Enter: opens the selected commit or file.
    Open,
    /// Esc: leaves the commit view.
    Back,
    /// `t`: switches between the unstaged and staged lists.
    ToggleStaged,
    /// `h`: stages the first hunk of the file in the diff (`stageFirstHunk`).
    StageFirstHunk,
    /// Switches the diff between unified and side by side. The TS app has a toolbar button for this.
    ToggleDiffView,
    /// Shift+L: loads a diff past the display limit.
    LoadLargeDiff,
}

/// The command for a key that the focused widget did not take. `None` for keys the ported screens do not use.
pub fn command_for(key: &KeyEvent) -> Option<Command> {
    if key.kind == KeyEventKind::Release {
        return None;
    }
    let command = if key.matches("q") || key.matches("ctrl+c") {
        Command::Quit
    } else if key.matches("up") || key.matches("k") {
        Command::MoveCommit(-1)
    } else if key.matches("down") || key.matches("j") {
        Command::MoveCommit(1)
    } else if key.matches("left") {
        Command::ScrollGraph(-1)
    } else if key.matches("right") {
        Command::ScrollGraph(1)
    } else if key.matches("r") {
        Command::Refresh
    } else if key.matches("tab") {
        Command::SwitchPane
    } else if key.matches("enter") || key.matches("return") {
        Command::Open
    } else if key.matches("esc") || key.matches("escape") {
        Command::Back
    } else if key.matches("t") {
        Command::ToggleStaged
    } else if key.matches("h") {
        Command::StageFirstHunk
    } else if key.matches("v") {
        Command::ToggleDiffView
    } else if key.matches("shift+l") {
        Command::LoadLargeDiff
    } else {
        return None;
    };
    Some(command)
}
