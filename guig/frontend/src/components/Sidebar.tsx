import { useMemo, useState } from "react";
import type { JSX } from "react";
import type {
  BranchRef,
  RepositorySnapshot,
  Stash,
  Worktree,
} from "../../../shared/types.js";

export interface SidebarSelection {
  branch?: string;
  stash?: string;
  worktree?: string;
  submodule?: string;
}

interface SidebarProps {
  snapshot: RepositorySnapshot | undefined;
  selection: SidebarSelection;
  onSelectBranch?: (branch: BranchRef) => void;
  onCheckoutBranch?: (branch: BranchRef) => void;
  onSelectStash?: (stash: Stash) => void;
  onSelectWorktree?: (worktree: Worktree) => void;
  onSelectSubmodule?: (path: string) => void;
}

type Presence = "both" | "local" | "remote" | "none";

function stripRemotePrefix(name: string): string {
  return name
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
}

export function displayBranchName(name: string): string {
  return name
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
}

function branchPresence(
  branch: BranchRef,
  refs: readonly BranchRef[],
): Presence {
  const short =
    branch.remote && branch.name.includes("/")
      ? branch.name.slice(branch.name.indexOf("/") + 1)
      : branch.name.replace(/^refs\/(heads|remotes)\//, "");
  const local = refs.some(
    (ref) =>
      !ref.remote &&
      (ref.name === short ||
        ref.name === branch.name ||
        ref.fullName === branch.fullName),
  );
  const remote = refs.some(
    (ref) =>
      ref.remote &&
      (ref.name === branch.name ||
        ref.name.endsWith(`/${short}`) ||
        stripRemotePrefix(ref.name) === short),
  );
  if (local && remote) return "both";
  if (local) return "local";
  if (remote) return "remote";
  return branch.remote ? "remote" : "local";
}

export function presenceMarker(
  branch: BranchRef,
  refs: readonly BranchRef[],
): string {
  if (branch.current) return "\u25C9";
  const presence = branchPresence(branch, refs);
  if (presence === "both") return "\u25C6";
  if (presence === "remote") return "\u25CC";
  return "\u25CB";
}

function matchesFilter(branch: BranchRef, filter: string): boolean {
  if (!filter) return true;
  const query = filter.toLowerCase();
  return (
    branch.name.toLowerCase().includes(query) ||
    displayBranchName(branch.name).toLowerCase().includes(query)
  );
}

export function Sidebar({
  snapshot,
  selection,
  onSelectBranch,
  onCheckoutBranch,
  onSelectStash,
  onSelectWorktree,
  onSelectSubmodule,
}: SidebarProps): JSX.Element {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState({
    local: false,
    remote: false,
    submodules: false,
    stashes: false,
    worktrees: false,
  });
  type CollapsedState = typeof collapsed;

  const branches = useMemo(
    () => snapshot?.branches ?? [],
    [snapshot?.branches],
  );

  const localBranches = branches.filter(
    (branch) => !branch.remote && matchesFilter(branch, filter),
  );
  const remoteBranches = branches.filter(
    (branch) => branch.remote && matchesFilter(branch, filter),
  );

  const toggle = (key: keyof typeof collapsed): void => {
    setCollapsed((prev: CollapsedState) => ({ ...prev, [key]: !prev[key] }));
  };

  const checkout = (branch: BranchRef): void => {
    onCheckoutBranch?.(branch);
  };

  const renderHeader = (
    key: keyof typeof collapsed,
    label: string,
    count: number,
  ): JSX.Element => (
    <button
      type="button"
      className="guig-section-header"
      onClick={() => toggle(key)}
      aria-expanded={!collapsed[key]}
    >
      <span aria-hidden="true">{collapsed[key] ? "\u25B6" : "\u25BC"}</span>
      <span>{label}</span>
      <span className="count">{count}</span>
    </button>
  );

  return (
    <aside className="guig-sidebar" aria-label="Repository">
      <div className="repo-label">REPOSITORY</div>
      <div className="guig-filter">
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="/ filter branches"
          aria-label="Filter branches"
        />
      </div>

      {renderHeader("local", "LOCAL BRANCHES", localBranches.length)}
      {!collapsed.local && (
        <div>
          {localBranches.length === 0 && (
            <div className="guig-empty">(none)</div>
          )}
          {localBranches.map((branch) => (
            <button
              key={branch.fullName}
              type="button"
              className={`guig-branch-row${selection.branch === branch.fullName ? " selected" : ""}`}
              onClick={() => onSelectBranch?.(branch)}
              onDoubleClick={() => checkout(branch)}
              onContextMenu={(event) => {
                event.preventDefault();
                window.dispatchEvent(
                  new CustomEvent("guig:branch-menu", {
                    detail: {
                      ref: branch.fullName,
                      x: event.clientX,
                      y: event.clientY,
                    },
                  }),
                );
              }}
              title={branch.fullName}
            >
              <span
                className={`presence${branch.current ? " current" : ""}`}
                aria-hidden="true"
              >
                {presenceMarker(branch, branches)}
              </span>
              <span>{displayBranchName(branch.name)}</span>
            </button>
          ))}
        </div>
      )}

      {renderHeader("remote", "REMOTES", remoteBranches.length)}
      {!collapsed.remote && (
        <div>
          {remoteBranches.length === 0 && (
            <div className="guig-empty">(none)</div>
          )}
          {remoteBranches.map((branch) => (
            <button
              key={branch.fullName}
              type="button"
              className={`guig-branch-row${selection.branch === branch.fullName ? " selected" : ""}`}
              onClick={() => onSelectBranch?.(branch)}
              onDoubleClick={() => checkout(branch)}
              onContextMenu={(event) => {
                event.preventDefault();
                window.dispatchEvent(
                  new CustomEvent("guig:branch-menu", {
                    detail: {
                      ref: branch.fullName,
                      x: event.clientX,
                      y: event.clientY,
                    },
                  }),
                );
              }}
              title={branch.fullName}
            >
              <span className="presence" aria-hidden="true">
                {presenceMarker(branch, branches)}
              </span>
              <span>{displayBranchName(branch.name)}</span>
            </button>
          ))}
        </div>
      )}

      {renderHeader(
        "submodules",
        "SUBMODULES",
        snapshot?.submodules.length ?? 0,
      )}
      {!collapsed.submodules && (
        <div>
          {(snapshot?.submodules.length ?? 0) === 0 && (
            <div className="guig-empty">(none)</div>
          )}
          {snapshot?.submodules.map((submodule) => (
            <div key={submodule.path}>
              <button
                type="button"
                className={`guig-submodule-row${selection.submodule === submodule.path ? " selected" : ""}`}
                onClick={() => onSelectSubmodule?.(submodule.path)}
                title={submodule.path}
              >
                <span aria-hidden="true">
                  {submodule.state === "clean"
                    ? "\u2713"
                    : submodule.state === "uninitialized"
                      ? "\u2716"
                      : "!"}
                </span>
                <span>
                  {submodule.path.split("/").filter(Boolean).at(-1) ??
                    submodule.path}
                </span>
              </button>
              <span className="guig-row-detail">{submodule.path}</span>
            </div>
          ))}
        </div>
      )}

      {renderHeader("stashes", "STASHES", snapshot?.stashes.length ?? 0)}
      {!collapsed.stashes && (
        <div>
          {(snapshot?.stashes.length ?? 0) === 0 && (
            <div className="guig-empty">(none)</div>
          )}
          {snapshot?.stashes.map((stash) => (
            <div key={stash.ref}>
              <button
                type="button"
                className={`guig-stash-row${selection.stash === stash.ref ? " selected" : ""}`}
                onClick={() => onSelectStash?.(stash)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  window.dispatchEvent(
                    new CustomEvent("guig:stash-menu", {
                      detail: {
                        stash: stash.ref,
                        x: event.clientX,
                        y: event.clientY,
                      },
                    }),
                  );
                }}
                title={stash.subject}
              >
                <span aria-hidden="true">{"\u25C7"}</span>
                <span>{stash.subject}</span>
              </button>
              <span className="guig-row-detail">
                on {stash.branch ?? "unknown branch"} {"\u2022"}{" "}
                {stash.createdAt}
              </span>
            </div>
          ))}
        </div>
      )}

      {renderHeader("worktrees", "WORKTREES", snapshot?.worktrees.length ?? 0)}
      {!collapsed.worktrees && (
        <div>
          {(snapshot?.worktrees.length ?? 0) === 0 && (
            <div className="guig-empty">(none)</div>
          )}
          {snapshot?.worktrees.map((worktree) => {
            const current =
              snapshot != null &&
              worktree.path.replace(/\/+$/, "") ===
                snapshot.root.replace(/\/+$/, "");
            return (
              <button
                key={worktree.path}
                type="button"
                className={`guig-worktree-row${selection.worktree === worktree.path || current ? " selected" : ""}`}
                onClick={() => onSelectWorktree?.(worktree)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  window.dispatchEvent(
                    new CustomEvent("guig:worktree-menu", {
                      detail: {
                        worktree: worktree.path,
                        x: event.clientX,
                        y: event.clientY,
                      },
                    }),
                  );
                }}
                title={worktree.path}
              >
                <span
                  className={current ? "current" : undefined}
                  aria-hidden="true"
                >
                  {current ? "\u25C9" : "\u2387"}
                </span>
                <span>
                  {worktree.path.replace(/\/+$/, "").split("/").at(-1)}
                </span>
                {worktree.prunable && (
                  <span className="guig-warn-flag" title="Prunable">
                    {"\u26A0"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
