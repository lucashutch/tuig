import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent, JSX } from "react";
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
import { HistoryPane } from "./components/HistoryPane.js";
import { CommitDetail } from "./components/CommitDetail.js";
import { DiffViewer } from "./components/DiffViewer.js";
import { ChangesPane } from "./components/ChangesPane.js";
import { Composer } from "./components/Composer.js";
import { ContextMenu } from "./components/ContextMenu.js";
import { MessageDialog } from "./components/Dialogs.js";
import type { GuigApi } from "../../shared/ipc.js";
import type {
  BranchRef,
  ChangedFile,
  Commit,
  DiffRequest,
} from "../../shared/types.js";

function repoName(root: string): string {
  return root.split("/").filter(Boolean).at(-1) ?? "repository";
}

function formatAge(syncedAt: number | undefined, now: number): string {
  if (syncedAt === undefined) return "not synced";
  const seconds = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (seconds < 10) return "synced just now";
  if (seconds < 60) return `synced ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `synced ${minutes}m ago`;
  return `synced ${Math.floor(minutes / 60)}h ago`;
}

function backend(): GuigApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { guig?: GuigApi }).guig;
}

function localBranchName(branch: BranchRef): string {
  return branch.name.replace(/^refs\/heads\//, "");
}

function remoteLocalName(branch: BranchRef): string {
  const short = branch.name.replace(/^refs\/remotes\//, "");
  const slash = short.indexOf("/");
  return slash >= 0 ? short.slice(slash + 1) : short;
}

function readFetchIntervalMinutes(): number {
  try {
    const raw = window.localStorage.getItem("guig.fetchIntervalMinutes");
    if (raw === null || raw.trim() === "") return 1;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 1;
    return parsed;
  } catch {
    return 1;
  }
}

export function App(): JSX.Element {
  const [repoPath, setRepoPath] = useState<string | undefined>(undefined);
  const { snapshot, loading, error, lastSyncedAt, refresh } =
    useSnapshot(repoPath);
  const [selection, setSelection] = useState<SidebarSelection>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<"info" | "ok" | "progress" | "error">(
    "info",
  );
  const [dialogError, setDialogError] = useState<string | null>(null);

  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(
    null,
  );
  const [selectedCommitCache, setSelectedCommitCache] = useState<Commit | null>(
    null,
  );
  const [selectedFile, setSelectedFile] = useState<string | undefined>(
    undefined,
  );
  const [stagedPreview, setStagedPreview] = useState(false);
  const [contextLines, setContextLines] = useState(3);

  const [pagedCommits, setPagedCommits] = useState<Commit[]>([]);
  const [pageComplete, setPageComplete] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(true);
      setKind("progress");
      setMessage(label);
      try {
        await action();
        setKind("ok");
        setMessage(`${label} done`);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        setKind("error");
        setMessage(text);
        setDialogError(text);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const fail = useCallback((text: string) => {
    setKind("error");
    setMessage(text);
  }, []);

  const commits: Commit[] = [...(snapshot?.commits ?? []), ...pagedCommits];

  useEffect(() => {
    setPagedCommits([]);
    setPageComplete(snapshot?.commitsComplete ?? true);
  }, [snapshot?.commits, snapshot?.commitsComplete]);

  const selectedCommit: Commit | null = selectedCommitSha
    ? (commits.find((commit) => commit.sha === selectedCommitSha) ??
      (selectedCommitCache?.sha === selectedCommitSha
        ? selectedCommitCache
        : null))
    : null;

  const selectCommit = useCallback(
    (sha: string) => {
      const found = commits.find((commit) => commit.sha === sha) ?? null;
      if (found) setSelectedCommitCache(found);
      setSelectedCommitSha(sha);
      setSelectedFile(undefined);
    },
    [commits],
  );

  const returnToWorkcopy = useCallback(() => {
    setSelectedCommitSha(null);
  }, []);

  const loadMore = useCallback(() => {
    const api = backend();
    if (!api?.commitPage || loadingMore) return;
    setLoadingMore(true);
    const skip = commits.length;
    void api
      .commitPage(250, skip)
      .then((page) => {
        setPagedCommits((prev) => [...prev, ...page.commits]);
        setPageComplete(page.complete);
      })
      .catch((err: unknown) =>
        fail(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoadingMore(false));
  }, [commits.length, fail, loadingMore]);

  const checkoutBranchRef = useCallback(
    (branch: BranchRef) => {
      setSelection((prev: SidebarSelection) => ({
        ...prev,
        branch: branch.fullName,
      }));
      void run(`Checking out ${branch.name}`, async () => {
        const api = backend();
        if (!api) return;
        if (branch.remote) {
          await api.checkoutRemoteBranch(remoteLocalName(branch), branch.name);
        } else {
          await api.switchBranch(localBranchName(branch));
        }
        await refresh();
      });
    },
    [refresh, run],
  );

  const checkoutCommit = useCallback(
    (sha: string) => {
      void run("Checking out commit", async () => {
        await backend()?.checkoutCommit(sha);
        await refresh();
      });
    },
    [refresh, run],
  );

  useEffect(() => {
    const onGraphCheckoutBranch = (event: Event): void => {
      const detail = (event as CustomEvent<{ ref?: string; sha?: string }>)
        .detail;
      const ref = detail?.ref;
      if (!ref) return;
      const match = snapshot?.branches.find(
        (branch) => branch.fullName === ref || branch.name === ref,
      );
      if (match) {
        checkoutBranchRef(match);
        return;
      }
      void run(`Checking out ${ref}`, async () => {
        const api = backend();
        if (!api) return;
        if (ref.startsWith("refs/remotes/") || ref.includes("/")) {
          const short = ref
            .replace(/^refs\/remotes\//, "")
            .replace(/^refs\/heads\//, "");
          const slash = short.indexOf("/");
          const local =
            slash >= 0 && ref.startsWith("refs/remotes/")
              ? short.slice(slash + 1)
              : short;
          if (ref.startsWith("refs/remotes/")) {
            await api.checkoutRemoteBranch(local, ref);
          } else {
            await api.switchBranch(short);
          }
        } else {
          await api.switchBranch(ref);
        }
        await refresh();
      });
    };
    const onGraphCheckoutCommit = (event: Event): void => {
      const sha = (event as CustomEvent<{ sha?: string }>).detail?.sha;
      if (sha) checkoutCommit(sha);
    };
    const onInspect = (event: Event): void => {
      const sha = (event as CustomEvent<{ sha?: string }>).detail?.sha;
      if (sha) selectCommit(sha);
    };
    const onReturn = (): void => returnToWorkcopy();
    const onRefresh = (): void => {
      void refresh();
    };
    window.addEventListener("guig:checkout-branch", onGraphCheckoutBranch);
    window.addEventListener("guig:checkout-commit", onGraphCheckoutCommit);
    window.addEventListener("guig:inspect-commit", onInspect);
    window.addEventListener("guig:return-workcopy", onReturn);
    window.addEventListener("guig:refresh", onRefresh);
    return () => {
      window.removeEventListener("guig:checkout-branch", onGraphCheckoutBranch);
      window.removeEventListener("guig:checkout-commit", onGraphCheckoutCommit);
      window.removeEventListener("guig:inspect-commit", onInspect);
      window.removeEventListener("guig:return-workcopy", onReturn);
      window.removeEventListener("guig:refresh", onRefresh);
    };
  }, [
    checkoutBranchRef,
    checkoutCommit,
    refresh,
    run,
    selectCommit,
    returnToWorkcopy,
    snapshot?.branches,
  ]);

  useEffect(() => {
    const minutes = readFetchIntervalMinutes();
    if (!(minutes > 0)) return;
    const timer = window.setInterval(() => {
      void fetchRemote(refresh).catch(() => undefined);
    }, minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const fetchDiff = useCallback((request: DiffRequest): Promise<string> => {
    const api = backend();
    if (!api)
      return Promise.resolve("(preview unavailable: backend not connected)");
    return api.diff(request);
  }, []);

  const getCommitFiles = useCallback((sha: string): Promise<ChangedFile[]> => {
    const api = backend();
    if (!api) return Promise.resolve([]);
    return api.commitFiles(sha);
  }, []);

  const handleAction = useCallback(
    (action: ToolbarActionId) => {
      switch (action) {
        case "fetch":
          void run("Fetching", () => fetchRemote(refresh));
          break;
        case "pull":
          void run("Pulling", () => pullRemote(refresh));
          break;
        case "push":
          void run("Pushing", () => pushRemote(refresh));
          break;
        case "stash":
          void run("Stashing", () => stashChanges(refresh));
          break;
        case "pop":
          void run("Popping stash", () => {
            const ref =
              selection.stash ?? snapshot?.stashes[0]?.ref ?? "stash@{0}";
            return popStash(ref, refresh);
          });
          break;
        case "refresh":
          void run("Refreshing", () => refresh());
          break;
      }
    },
    [refresh, run, selection.stash, snapshot?.stashes],
  );

  const branch = snapshot?.branch ?? "detached HEAD";
  const dirty = snapshot?.files.length ?? 0;
  const stagedCount = snapshot?.files.filter((file) => file.staged).length ?? 0;

  return (
    <div className="guig-shell">
      <header className="guig-header">
        <span className="repo-name">
          {"\u25C9"} {snapshot ? repoName(snapshot.root) : "guig"}
        </span>
        <span className="branch-name">{snapshot ? branch : "loading"}</span>
        {snapshot != null && snapshot.ahead > 0 && (
          <span className="ahead">
            {"\u2191"}
            {snapshot.ahead}
          </span>
        )}
        {snapshot != null && snapshot.behind > 0 && (
          <span className="behind">
            {"\u2193"}
            {snapshot.behind}
          </span>
        )}
        {snapshot != null && (
          <span className="muted">
            {dirty > 0 ? `${dirty} changed` : "clean"}
          </span>
        )}
        <label className="muted">
          repo{" "}
          <input
            type="text"
            value={repoPath ?? ""}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setRepoPath(event.target.value || undefined)
            }
            placeholder="/path/to/repo"
            aria-label="Repository path"
            size={24}
          />
        </label>
        <span className="sync-age">{formatAge(lastSyncedAt, Date.now())}</span>
      </header>

      <Toolbar
        snapshot={snapshot}
        busy={busy || loading}
        onAction={handleAction}
      />

      <Sidebar
        snapshot={snapshot}
        selection={selection}
        onSelectBranch={(picked) =>
          setSelection((prev: SidebarSelection) => ({
            ...prev,
            branch: picked.fullName,
          }))
        }
        onCheckoutBranch={checkoutBranchRef}
        onSelectStash={(stash) =>
          setSelection((prev: SidebarSelection) => ({
            ...prev,
            stash: stash.ref,
          }))
        }
        onSelectWorktree={(worktree) =>
          setSelection((prev: SidebarSelection) => ({
            ...prev,
            worktree: worktree.path,
          }))
        }
        onSelectSubmodule={(path) =>
          setSelection((prev: SidebarSelection) => ({
            ...prev,
            submodule: path,
          }))
        }
      />

      <main className="guig-main" data-testid="history-pane">
        <HistoryPane
          commits={commits}
          refs={snapshot?.branches}
          selectedSha={selectedCommitSha}
          hasMore={snapshot !== undefined && !pageComplete}
          loadingMore={loadingMore}
          onSelect={selectCommit}
          onLoadMore={loadMore}
        />
        {selectedCommitSha != null && (
          <CommitDetail
            commit={selectedCommit}
            getCommitFiles={getCommitFiles}
            selectedPath={selectedFile}
            onSelectFile={setSelectedFile}
          />
        )}
        <DiffViewer
          commitSha={selectedCommitSha ?? undefined}
          path={selectedFile}
          staged={selectedCommitSha != null ? undefined : stagedPreview}
          fetchDiff={fetchDiff}
          contextLines={contextLines}
          onContextChange={setContextLines}
        />
        {error && <div>Snapshot error: {error}</div>}
      </main>

      <div className="guig-aside" data-testid="changes-pane">
        <ChangesPane
          files={snapshot?.files ?? []}
          selectedPath={selectedFile}
          onSelect={setSelectedFile}
          onPreview={(path, staged) => {
            setSelectedFile(path);
            setStagedPreview(staged);
          }}
          onError={fail}
        />
        <Composer
          stagedCount={stagedCount}
          onError={fail}
          onCommitted={() => {
            void refresh();
          }}
        />
      </div>

      <StatusBar message={message} kind={kind} />
      <ContextMenu />
      <MessageDialog
        open={dialogError !== null}
        message={dialogError ?? ""}
        onClose={() => setDialogError(null)}
      />
    </div>
  );
}
