import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { GuigApi, ResetRequest } from "../../../shared/ipc.js";
import type { ResetMode } from "../../../shared/types.js";
import { ConfirmDialog, MessageDialog, PromptDialog } from "./Dialogs.js";

function backend(): GuigApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { guig?: GuigApi }).guig;
}

function emitRefresh(): void {
  window.dispatchEvent(new CustomEvent("guig:refresh"));
}

function copyText(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) return Promise.reject(new Error("Clipboard is unavailable"));
  return clipboard.writeText(text);
}

/** Where the menu opened and what it acts on. */
export interface MenuTarget {
  x: number;
  y: number;
  sha?: string;
  /** Branch ref: full (refs/heads/…) or short name. */
  ref?: string;
  stash?: string;
  worktree?: string;
}

interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => Promise<void>;
}

interface PendingPrompt {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  submit: (value: string) => Promise<void>;
}

function shortBranchName(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
}

function readDetail(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null)
    return raw as Record<string, unknown>;
  if (typeof raw === "string") return { sha: raw };
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const MENU_EVENTS = [
  "guig:graph-menu",
  "guig:branch-menu",
  "guig:stash-menu",
  "guig:worktree-menu",
  "guig:file-menu",
] as const;

const menuStyle = (x: number, y: number): React.CSSProperties => ({
  position: "fixed",
  left: Math.min(x, window.innerWidth - 260),
  top: Math.min(y, window.innerHeight - 320),
  minWidth: 220,
  maxWidth: 260,
  background: "#21252b",
  border: "1px solid #4b5263",
  borderRadius: 6,
  padding: 4,
  zIndex: 900,
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.5)",
});

const itemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  borderRadius: 4,
  color: "#d7dae0",
  cursor: "pointer",
  fontSize: 13,
  padding: "6px 10px",
};

const dangerItemStyle: React.CSSProperties = {
  ...itemStyle,
  color: "#ef596f",
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#7f848e",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "8px 10px 2px",
};

const separatorStyle: React.CSSProperties = {
  borderTop: "1px solid #3e4451",
  margin: "4px 0",
};

/** Right-click menu for graph rows, branches, stashes, and worktrees. */
export function ContextMenu(): JSX.Element {
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cursor = useRef({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = (event: MouseEvent): void => {
      cursor.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("contextmenu", track, true);
    return () => window.removeEventListener("contextmenu", track, true);
  }, []);

  useEffect(() => {
    const open = (event: Event): void => {
      const detail = readDetail((event as CustomEvent).detail);
      const fromEvent = detail as { x?: number; y?: number };
      setTarget({
        x: typeof fromEvent.x === "number" ? fromEvent.x : cursor.current.x,
        y: typeof fromEvent.y === "number" ? fromEvent.y : cursor.current.y,
        sha: asString(detail.sha),
        ref: asString(detail.ref ?? detail.branch ?? detail.fullName),
        stash: asString(detail.stash),
        worktree: asString(detail.worktree ?? detail.path),
      });
    };
    for (const name of MENU_EVENTS) window.addEventListener(name, open);
    return () => {
      for (const name of MENU_EVENTS) window.removeEventListener(name, open);
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setTarget(null);
      }
    };
    const onDown = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node))
        setTarget(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [target]);

  const close = (): void => setTarget(null);

  const mutate = async (work: () => Promise<void>): Promise<void> => {
    const api = backend();
    if (!api) {
      setError("Git backend is not connected.");
      return;
    }
    setBusy(true);
    try {
      await work();
      close();
      emitRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const askConfirm = (pending: PendingConfirm): void => {
    close();
    setConfirm(pending);
  };

  const runConfirm = async (): Promise<void> => {
    const pending = confirm;
    if (!pending) return;
    setBusy(true);
    try {
      await pending.run();
      setConfirm(null);
      emitRefresh();
    } catch (err) {
      setConfirm(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runPrompt = async (value: string): Promise<void> => {
    const pending = prompt;
    if (!pending) return;
    setBusy(true);
    try {
      await pending.submit(value);
      setPrompt(null);
      emitRefresh();
    } catch (err) {
      setPrompt(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!target) {
    return (
      <>
        <ConfirmDialog
          open={confirm !== null}
          title={confirm?.title ?? ""}
          message={confirm?.message ?? ""}
          confirmLabel={confirm?.confirmLabel ?? "Confirm"}
          busy={busy}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
        <PromptDialog
          open={prompt !== null}
          title={prompt?.title ?? ""}
          label={prompt?.label ?? ""}
          initialValue={prompt?.initialValue}
          placeholder={prompt?.placeholder}
          confirmLabel={prompt?.confirmLabel}
          onSubmit={(value) => void runPrompt(value)}
          onCancel={() => setPrompt(null)}
        />
        <MessageDialog
          open={error !== null}
          message={error ?? ""}
          onClose={() => setError(null)}
        />
      </>
    );
  }

  const { sha, ref, stash, worktree } = target;
  const branchShort = ref ? shortBranchName(ref) : undefined;
  const remote = ref ? ref.startsWith("refs/remotes/") : false;

  const items: JSX.Element[] = [];
  const push = (
    key: string,
    label: string,
    onClick: () => void,
    danger = false,
  ): void => {
    items.push(
      <button
        key={key}
        type="button"
        style={danger ? dangerItemStyle : itemStyle}
        disabled={busy}
        onMouseEnter={(event) => {
          (event.currentTarget as HTMLButtonElement).style.background =
            "#2c313c";
        }}
        onMouseLeave={(event) => {
          (event.currentTarget as HTMLButtonElement).style.background = "none";
        }}
        onClick={onClick}
      >
        {label}
      </button>,
    );
  };
  const pushSeparator = (key: string): void => {
    items.push(<div key={key} style={separatorStyle} />);
  };
  const pushGroup = (key: string, label: string): void => {
    items.push(
      <div key={key} style={groupLabelStyle}>
        {label}
      </div>,
    );
  };

  if (ref && branchShort) {
    pushGroup("g-branch", `Branch ${branchShort}`);
    push(
      "checkout-branch",
      remote
        ? `Check out ${branchShort} (track remote)`
        : `Check out ${branchShort}`,
      () => {
        const name = branchShort;
        const remoteName = ref;
        void mutate(() =>
          remote && backend()
            ? backend()!.checkoutRemoteBranch(name, remoteName)
            : backend()!.switchBranch(name),
        );
      },
    );
    push("copy-branch", "Copy branch name", () => {
      void copyText(branchShort)
        .then(close)
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
    });
    push(
      "delete-branch",
      `Delete branch ${branchShort}`,
      () =>
        askConfirm({
          title: "Delete branch",
          message: `Delete branch "${branchShort}"? Commits not on another branch become unreachable.`,
          confirmLabel: "Delete",
          run: () =>
            backend()!.deleteBranch(remote ? ref : branchShort, false, remote),
        }),
      true,
    );
    if (items.length > 0) pushSeparator("s-branch");
  }

  if (sha) {
    pushGroup("g-commit", `Commit ${sha.slice(0, 8)}`);
    push("checkout-detached", "Check out commit (detached HEAD)", () => {
      const commit = sha;
      void mutate(() => backend()!.checkoutCommit(commit));
    });
    push("create-branch", "Create branch from commit…", () => {
      const commit = sha;
      setTarget(null);
      setPrompt({
        title: "Create branch",
        label: "Branch name",
        placeholder: "feature/my-branch",
        confirmLabel: "Create",
        submit: (value) => backend()!.createBranch(value, commit),
      });
    });
    push("rebase-onto", "Rebase current branch onto commit", () => {
      const commit = sha;
      void mutate(() => backend()!.rebaseOnto(commit));
    });
    push("cherry-pick", "Cherry-pick commit", () => {
      const commit = sha;
      void mutate(() => backend()!.cherryPick(commit));
    });
    pushGroup("g-reset", "Reset current branch to commit");
    const resetModes: ResetMode[] = ["soft", "mixed", "hard"];
    for (const mode of resetModes) {
      const request: ResetRequest = { sha, mode };
      if (mode === "hard") {
        push(
          `reset-${mode}`,
          `Reset --${mode} (destroys changes)`,
          () =>
            askConfirm({
              title: "Hard reset",
              message: `Hard-reset the current branch to ${sha.slice(0, 8)}? Staged and unstaged changes are destroyed.`,
              confirmLabel: "Hard reset",
              run: () => backend()!.resetTo(request.sha, request.mode),
            }),
          true,
        );
      } else {
        push(`reset-${mode}`, `Reset --${mode}`, () => {
          const req = request;
          void mutate(() => backend()!.resetTo(req.sha, req.mode));
        });
      }
    }
    push("copy-sha", "Copy commit SHA", () => {
      void copyText(sha)
        .then(close)
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
    });
    pushSeparator("s-commit");
  }

  if (stash) {
    pushGroup("g-stash", stash);
    const stashRef = stash;
    push(
      "stash-apply",
      "Apply stash",
      () => void mutate(() => backend()!.applyStash(stashRef)),
    );
    push(
      "stash-pop",
      "Pop stash",
      () => void mutate(() => backend()!.popStash(stashRef)),
    );
    push(
      "stash-drop",
      "Drop stash",
      () =>
        askConfirm({
          title: "Drop stash",
          message: `Drop ${stashRef}? Its changes cannot be recovered.`,
          confirmLabel: "Drop",
          run: () => backend()!.dropStash(stashRef),
        }),
      true,
    );
    pushSeparator("s-stash");
  }

  if (worktree) {
    pushGroup("g-worktree", worktree);
    const path = worktree;
    push(
      "worktree-lock",
      "Lock worktree",
      () => void mutate(() => backend()!.lockWorktree(path, true)),
    );
    push(
      "worktree-unlock",
      "Unlock worktree",
      () => void mutate(() => backend()!.lockWorktree(path, false)),
    );
    push(
      "worktree-remove",
      "Remove worktree",
      () =>
        askConfirm({
          title: "Remove worktree",
          message: `Remove worktree at ${path}?`,
          confirmLabel: "Remove",
          run: () => backend()!.removeWorktree(path),
        }),
      true,
    );
    pushSeparator("s-worktree");
  }

  if (items.length > 0) items.pop();

  return (
    <>
      <div ref={menuRef} role="menu" style={menuStyle(target.x, target.y)}>
        {items.length > 0 ? (
          items
        ) : (
          <div style={groupLabelStyle}>No actions</div>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        confirmLabel={confirm?.confirmLabel ?? "Confirm"}
        busy={busy}
        onConfirm={() => void runConfirm()}
        onCancel={() => setConfirm(null)}
      />
      <PromptDialog
        open={prompt !== null}
        title={prompt?.title ?? ""}
        label={prompt?.label ?? ""}
        initialValue={prompt?.initialValue}
        placeholder={prompt?.placeholder}
        confirmLabel={prompt?.confirmLabel}
        onSubmit={(value) => void runPrompt(value)}
        onCancel={() => setPrompt(null)}
      />
      <MessageDialog
        open={error !== null}
        message={error ?? ""}
        onClose={() => setError(null)}
      />
    </>
  );
}

/** Menu event payload shared with graph and sidebar emitters. */
export interface GraphMenuDetail {
  sha?: string;
  ref?: string;
  x?: number;
  y?: number;
}
