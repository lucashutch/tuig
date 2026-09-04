import { useState } from "react";
import type { JSX } from "react";
import {
  fetchRemote,
  popStash,
  pullRemote,
  pushRemote,
  stashChanges,
  useSnapshot,
} from "./api.js";
import { Sidebar, type SidebarSelection } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { Toolbar, type ToolbarActionId } from "./components/Toolbar.js";

export function App(): JSX.Element {
  const [repoPath, setRepoPath] = useState<string | undefined>(undefined);
  const { snapshot, loading, error, refresh } = useSnapshot(repoPath);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<SidebarSelection>({});
  const [message, setMessage] = useState<string | undefined>(undefined);

  const run = async (
    fn: (refresh: () => Promise<void>) => Promise<void>,
  ): Promise<void> => {
    setBusy(true);
    try {
      await fn(refresh);
      setMessage(undefined);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onAction = (action: ToolbarActionId): void => {
    switch (action) {
      case "fetch":
        void run(fetchRemote);
        break;
      case "pull":
        void run(pullRemote);
        break;
      case "push":
        void run(pushRemote);
        break;
      case "stash":
        void run(stashChanges);
        break;
      case "pop":
        if (selection.stash) {
          const ref = selection.stash;
          void run((done) => popStash(ref, done));
        }
        break;
      case "refresh":
        void refresh();
        break;
    }
  };

  return (
    <div className="guig-shell">
      <header className="guig-header">
        <input
          type="text"
          aria-label="Repository path"
          placeholder="/path/to/repo"
          value={repoPath ?? ""}
          onChange={(event) => setRepoPath(event.target.value || undefined)}
        />
      </header>
      <Toolbar snapshot={snapshot} busy={busy} onAction={onAction} />
      <div className="guig-main">
        <Sidebar
          snapshot={snapshot}
          selection={selection}
          onSelectBranch={(branch) => setSelection({ branch: branch.name })}
          onSelectStash={(stash) => setSelection({ stash: stash.ref })}
          onSelectWorktree={(worktree) =>
            setSelection({ worktree: worktree.path })
          }
          onSelectSubmodule={(path) => setSelection({ submodule: path })}
        />
        <main data-testid="history-pane">
          <div className="guig-placeholder">
            History arrives in the next commit.
          </div>
        </main>
        <div data-testid="changes-pane">
          <div className="guig-placeholder">
            Changes arrive in a later commit.
          </div>
        </div>
      </div>
      <StatusBar
        message={error ?? message ?? (loading ? "loading" : undefined)}
        kind={(error ?? message) ? "error" : loading ? "progress" : "info"}
      />
    </div>
  );
}
