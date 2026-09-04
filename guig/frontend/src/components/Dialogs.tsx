import { useEffect, useState } from "react";
import type { JSX } from "react";

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const cardStyle: React.CSSProperties = {
  background: "#282c34",
  border: "1px solid #4b5263",
  borderRadius: 6,
  padding: "16px",
  minWidth: 320,
  maxWidth: 480,
  color: "#d7dae0",
  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 8,
};

const messageStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#abb2bf",
  whiteSpace: "pre-wrap",
  marginBottom: 16,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
};

const buttonStyle: React.CSSProperties = {
  background: "#3e4451",
  color: "#d7dae0",
  border: "1px solid #4b5263",
  borderRadius: 4,
  padding: "4px 14px",
  cursor: "pointer",
  fontSize: 13,
};

const dangerStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#7a2e38",
  borderColor: "#ef596f",
  color: "#fff",
};

const primaryStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#4d78cc",
  borderColor: "#61afef",
  color: "#fff",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#21252b",
  border: "1px solid #4b5263",
  borderRadius: 4,
  color: "#d7dae0",
  padding: "6px 8px",
  fontSize: 13,
  marginBottom: 16,
};

function useEscape(onClose: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onClose]);
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation gate for destructive ops: hard reset, branch delete, overwrite, discard-all. */
export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element | null {
  useEscape(props.onCancel, props.open);
  if (!props.open) return null;
  return (
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={props.title}
        style={cardStyle}
      >
        <div style={titleStyle}>{props.title}</div>
        <div style={messageStyle}>{props.message}</div>
        <div style={rowStyle}>
          <button
            type="button"
            style={buttonStyle}
            onClick={props.onCancel}
            disabled={props.busy}
          >
            {props.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            style={props.danger === false ? primaryStyle : dangerStyle}
            onClick={props.onConfirm}
            disabled={props.busy}
            autoFocus
          >
            {props.busy ? "Working…" : (props.confirmLabel ?? "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** Single-field prompt: branch name, tag name, stash message, worktree path. */
export function PromptDialog(props: PromptDialogProps): JSX.Element | null {
  const [value, setValue] = useState(props.initialValue ?? "");
  useEscape(props.onCancel, props.open);
  useEffect(() => {
    if (props.open) setValue(props.initialValue ?? "");
  }, [props.open, props.initialValue]);
  if (!props.open) return null;
  const submit = (): void => {
    if (value.trim()) props.onSubmit(value.trim());
  };
  return (
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        style={cardStyle}
      >
        <div style={titleStyle}>{props.title}</div>
        <label
          style={{
            display: "block",
            fontSize: 12,
            color: "#7f848e",
            marginBottom: 6,
          }}
        >
          {props.label}
        </label>
        <input
          type="text"
          style={inputStyle}
          value={value}
          placeholder={props.placeholder}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div style={rowStyle}>
          <button type="button" style={buttonStyle} onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={primaryStyle}
            onClick={submit}
            disabled={!value.trim()}
          >
            {props.confirmLabel ?? "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface MessageDialogProps {
  open: boolean;
  title?: string;
  message: string;
  onClose: () => void;
}

/** Error and notice display. */
export function MessageDialog(props: MessageDialogProps): JSX.Element | null {
  useEscape(props.onClose, props.open);
  if (!props.open) return null;
  return (
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={props.title ?? "Message"}
        style={cardStyle}
      >
        <div style={titleStyle}>{props.title ?? "Error"}</div>
        <div style={messageStyle}>{props.message}</div>
        <div style={rowStyle}>
          <button
            type="button"
            style={buttonStyle}
            onClick={props.onClose}
            autoFocus
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
