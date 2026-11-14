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
    } else {
        return None;
    };
    Some(command)
}
