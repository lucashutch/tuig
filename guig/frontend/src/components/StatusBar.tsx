import type { JSX } from "react";

interface StatusBarProps {
  message: string | undefined;
  kind: "info" | "ok" | "progress" | "error";
}

const HINTS =
  "History: j/k move, Enter open \u2022 Changes: s stage, u unstage \u2022 Tab pane, r refresh, q quit";

export function StatusBar({ message, kind }: StatusBarProps): JSX.Element {
  return (
    <footer className="guig-statusbar">
      <span className="hints">{HINTS}</span>
      {message && (
        <span className={`message ${kind === "info" ? "" : kind}`}>
          {message}
        </span>
      )}
    </footer>
  );
}
