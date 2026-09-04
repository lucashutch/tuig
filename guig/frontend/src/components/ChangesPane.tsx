import { useEffect, useMemo, useState } from "react";
import type { ChangedFile } from "../../../shared/types.js";
import type { GuigApi } from "../../../shared/ipc.js";
import { FileTree } from "./FileTree.js";
import { ConfirmDialog } from "./Dialogs.js";

export interface ChangesPaneProps {
  files: ChangedFile[];
  selectedPath?: string;
  onSelect?: (path: string) => void;
  /** Called when a file row is activated, with which diff to show. */
  onPreview?: (path: string, staged: boolean) => void;
  stage?: (paths: string[]) => Promise<void>;
  unstage?: (paths: string[]) => Promise<void>;
  discard?: (paths: string[]) => Promise<void>;
  discardAll?: () => Promise<void>;
  fetchDiff?: (path: string, staged: boolean) => Promise<string>;
  applyPatch?: (patch: string) => Promise<void>;
  onError?: (message: string) => void;
}

type Api = Pick<
  GuigApi,
  "stage" | "unstage" | "discard" | "discardAll" | "diff" | "applyPatch"
>;

function backend(): Api | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { guig?: Api }).guig;
}

function emitRefresh(): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent("guig:refresh"));
}

/** Extract the first @@ hunk (with its file header) from a unified diff. */
export function firstHunkPatch(diff: string): string {
  const lines = diff.split("\n");
  const start = lines.findIndex((line) => line.startsWith("@@"));
  if (start < 0) throw new Error("No hunks in diff");
  let end = lines.findIndex(
    (line, index) => index > start && line.startsWith("@@"),
  );
  if (end < 0) end = lines.length;
  // Drop the trailing empty split element so the patch ends cleanly.
  while (end > start && lines[end - 1] === "") end -= 1;
  return `${lines.slice(0, end).join("\n")}\n`;
}

const DISCARD_ARM_MS = 5000;

/** Unstaged and Staged collapsible sections with per-file actions. */
export function ChangesPane({
  files,
  selectedPath,
  onSelect,
  onPreview,
  stage,
  unstage,
  discard,
  discardAll,
  fetchDiff,
  applyPatch,
  onError,
}: ChangesPaneProps): React.JSX.Element {
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [discardArmed, setDiscardArmed] = useState(false);
  const [pendingDiscardPath, setPendingDiscardPath] = useState<string | null>(
    null,
  );

  const unstaged = useMemo(() => files.filter((f) => f.unstaged), [files]);
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);

  const fail = (message: string): void => {
    setError(message);
    onError?.(message);
  };

  const run = async (key: string, work: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError(undefined);
    try {
      await work();
      emitRefresh();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  const doStage = (paths: string[]): Promise<void> =>
    run(`stage:${paths.join(",")}`, () =>
      (
        stage ??
        ((p) =>
          backend()?.stage(p) ??
          Promise.reject(new Error("backend not connected")))
      )(paths),
    );
  const doUnstage = (paths: string[]): Promise<void> =>
    run(`unstage:${paths.join(",")}`, () =>
      (
        unstage ??
        ((p) =>
          backend()?.unstage(p) ??
          Promise.reject(new Error("backend not connected")))
      )(paths),
    );
  const doDiscard = (paths: string[]): Promise<void> =>
    run(`discard:${paths.join(",")}`, () =>
      (
        discard ??
        ((p) =>
          backend()?.discard(p) ??
          Promise.reject(new Error("backend not connected")))
      )(paths),
    );

  const stageFirstHunk = async (path: string): Promise<void> => {
    await run(`hunk:${path}`, async () => {
      const text = await (
        fetchDiff ??
        ((p: string, s: boolean) => {
          const api = backend();
          if (!api) throw new Error("backend not connected");
          return api.diff({ path: p, staged: s });
        })
      )(path, false);
      const patch = firstHunkPatch(text);
      await (
        applyPatch ??
        ((p: string) => {
          const api = backend();
          if (!api) throw new Error("backend not connected");
          return api.applyPatch(p);
        })
      )(patch);
    });
  };

  const stageAll = (): Promise<void> => doStage(unstaged.map((f) => f.path));

  const confirmDiscardAll = (): void => {
    if (unstaged.length === 0) return;
    if (!discardArmed) {
      setDiscardArmed(true);
      window.setTimeout(() => setDiscardArmed(false), DISCARD_ARM_MS);
      return;
    }
    setDiscardArmed(false);
    void run("discard-all", () =>
      (
        discardAll ??
        (() =>
          backend()?.discardAll() ??
          Promise.reject(new Error("backend not connected")))
      )(),
    );
  };

  const handleSelect = (path: string): void => {
    onSelect?.(path);
    const file = files.find((f) => f.path === path);
    // Prefer the unstaged diff when a file has both sides.
    onPreview?.(path, file ? file.staged && !file.unstaged : false);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "t") {
        setUnstagedOpen((v) => !v);
        setStagedOpen((v) => !v);
      } else if (event.key === "s" && selectedPath) {
        void doStage([selectedPath]);
      } else if (event.key === "u" && selectedPath) {
        void doUnstage([selectedPath]);
      } else if (event.key === "h" && selectedPath) {
        void stageFirstHunk(selectedPath);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedPath, files]);

  const section = (
    title: string,
    open: boolean,
    setOpen: (v: boolean) => void,
    count: number,
    body: React.JSX.Element,
  ): React.JSX.Element => (
    <section className="guig-changes-section">
      <button
        type="button"
        className="guig-changes-header"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="Toggle section (t)"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {title} ({count})
      </button>
      {open && body}
    </section>
  );

  return (
    <div className="guig-changes">
      <div className="guig-changes-toolbar">
        <button
          type="button"
          onClick={() => void stageAll()}
          disabled={unstaged.length === 0 || busy !== undefined}
          title="Stage all"
        >
          Stage all
        </button>
        <button
          type="button"
          onClick={confirmDiscardAll}
          disabled={unstaged.length === 0 || busy !== undefined}
          title="Discard all (click twice to confirm)"
          aria-live="polite"
        >
          {discardArmed ? "Confirm discard all?" : "Discard all"}
        </button>
      </div>
      {error && (
        <div className="guig-changes-error" role="alert">
          {error}
        </div>
      )}
      {busy && <div className="guig-changes-busy">Working…</div>}
      {section(
        "Unstaged",
        unstagedOpen,
        setUnstagedOpen,
        unstaged.length,
        <FileTree
          files={unstaged}
          selectedPath={selectedPath}
          onSelect={handleSelect}
          onStage={(path) => void doStage([path])}
          onDiscard={(path) => setPendingDiscardPath(path)}
        />,
      )}
      {section(
        "Staged",
        stagedOpen,
        setStagedOpen,
        staged.length,
        <FileTree
          files={staged}
          selectedPath={selectedPath}
          onSelect={handleSelect}
          onUnstage={(path) => void doUnstage([path])}
        />,
      )}
      {selectedPath && (
        <button
          type="button"
          className="guig-changes-hunk"
          onClick={() => void stageFirstHunk(selectedPath)}
          disabled={busy !== undefined}
          title="Stage first hunk of selected file (h)"
        >
          Stage first hunk (h)
        </button>
      )}
      <ConfirmDialog
        open={pendingDiscardPath !== null}
        title="Discard changes"
        message={
          pendingDiscardPath !== null
            ? `Discard changes to "${pendingDiscardPath}"? This cannot be undone.`
            : ""
        }
        confirmLabel="Discard"
        busy={busy !== undefined}
        onConfirm={() => {
          const path = pendingDiscardPath;
          setPendingDiscardPath(null);
          if (path !== null) void doDiscard([path]);
        }}
        onCancel={() => setPendingDiscardPath(null)}
      />
    </div>
  );
}
