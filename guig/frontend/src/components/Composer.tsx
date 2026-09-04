import { useState } from "react";
import type { GuigApi } from "../../../shared/ipc.js";

export interface ComposerProps {
  stagedCount: number;
  commit?: (message: string) => Promise<void>;
  amend?: (message: string) => Promise<void>;
  stash?: (message?: string, includeUntracked?: boolean) => Promise<void>;
  onError?: (message: string) => void;
  onCommitted?: () => void;
}

type Api = Pick<GuigApi, "commit" | "amend" | "stash">;

function backend(): Api | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { guig?: Api }).guig;
}

function emitRefresh(): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent("guig:refresh"));
}

export function buildMessage(summary: string, description: string): string {
  const body = description.trim();
  return body ? `${summary.trim()}\n\n${body}` : summary.trim();
}

/** Commit composer plus stash-push actions. */
export function Composer({
  stagedCount,
  commit,
  amend,
  stash,
  onError,
  onCommitted,
}: ComposerProps): React.JSX.Element {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amendMode, setAmendMode] = useState(false);
  const [stashMessage, setStashMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const fail = (message: string): void => {
    setError(message);
    onError?.(message);
  };

  const doCommit = async (): Promise<void> => {
    if (stagedCount === 0 && !amendMode) {
      fail("Nothing staged to commit");
      return;
    }
    if (!summary.trim()) {
      fail("Commit summary is required");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const message = buildMessage(summary, description);
      if (amendMode)
        await (
          amend ??
          ((m: string) =>
            backend()?.amend(m) ??
            Promise.reject(new Error("backend not connected")))
        )(message);
      else
        await (
          commit ??
          ((m: string) =>
            backend()?.commit(m) ??
            Promise.reject(new Error("backend not connected")))
        )(message);
      setSummary("");
      setDescription("");
      emitRefresh();
      onCommitted?.();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doStash = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await (
        stash ??
        ((m?: string, u?: boolean) =>
          backend()?.stash(m, u) ??
          Promise.reject(new Error("backend not connected")))
      )(stashMessage.trim() || undefined, includeUntracked);
      setStashMessage("");
      emitRefresh();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="guig-composer">
      <label className="guig-composer-field">
        Summary
        <input
          type="text"
          value={summary}
          placeholder="Commit summary"
          onChange={(event) => setSummary(event.target.value)}
          disabled={busy}
        />
      </label>
      <label className="guig-composer-field">
        Description
        <textarea
          value={description}
          placeholder="Extended description (optional)"
          onChange={(event) => setDescription(event.target.value)}
          disabled={busy}
          rows={3}
        />
      </label>
      <div className="guig-composer-row">
        <label className="guig-composer-check">
          <input
            type="checkbox"
            checked={amendMode}
            onChange={(event) => setAmendMode(event.target.checked)}
            disabled={busy}
          />
          Amend
        </label>
        <button
          type="button"
          onClick={() => void doCommit()}
          disabled={busy}
          title={amendMode ? "Amend previous commit" : "Create commit"}
        >
          {amendMode ? "Amend" : "Commit"}
        </button>
      </div>
      {error && (
        <div className="guig-composer-error" role="alert">
          {error}
        </div>
      )}
      <div className="guig-stash">
        <label className="guig-composer-field">
          Stash message
          <input
            type="text"
            value={stashMessage}
            placeholder="Stash message (optional)"
            onChange={(event) => setStashMessage(event.target.value)}
            disabled={busy}
          />
        </label>
        <div className="guig-composer-row">
          <label className="guig-composer-check">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
              disabled={busy}
            />
            Include untracked
          </label>
          <button type="button" onClick={() => void doStash()} disabled={busy}>
            Stash
          </button>
        </div>
      </div>
    </div>
  );
}
