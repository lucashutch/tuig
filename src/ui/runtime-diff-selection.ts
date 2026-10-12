import { MouseButton } from "@opentui/core";
import { selectPatchLines } from "../git/hunks.js";
import type { ChangedFile, GitRepository } from "../git/types.js";
import { changedDiffRowsInRange } from "./diff-lines.js";
import type { DiffView } from "./diff-view.js";
import type { GraphMenuItem, GraphMenuTarget } from "./graph-menu.js";
import type { ChangeSection } from "./runtime-widgets.js";

export interface RuntimeDiffSelectionContext {
  repository: GitRepository;
  commitDiff: DiffView;
  diffOrigin?: "working" | "commit";
  mode: ChangeSection;
  comparisonBaseSha?: string;
  headSha?: string;
  selectedCommit: () => { sha: string; parents: readonly string[] } | undefined;
  selectedFile: () => ChangedFile | undefined;
  paintHints: () => void;
  notify: (text: string, tone?: "info" | "error" | "busy") => void;
  openPopup: (
    title: string,
    items: GraphMenuItem[],
    x: number,
    y: number,
    select: (item: GraphMenuItem) => void,
  ) => void;
  openGraphMenu: (x: number, y: number, target: GraphMenuTarget) => void;
  perform: (
    label: string,
    action: (signal?: AbortSignal) => Promise<void>,
    remote?: boolean,
    scope?: "history" | "working",
  ) => unknown;
}

/** Owns the selected diff rows, the drag state, and staging of selected lines. */
export class RuntimeDiffSelectionController {
  private rows = new Set<number>();
  private snapshot = "";
  private dragAnchor?: number;
  private dragSelecting = true;

  constructor(private readonly context: () => RuntimeDiffSelectionContext) {}

  get size() {
    return this.rows.size;
  }

  click(x: number, y: number, button: number, ctrl: boolean, alt: boolean) {
    const ctx = this.context();
    if (!ctx.commitDiff.visible) return;
    const hit = ctx.commitDiff.lineTargetAt(x, y);
    const file = ctx.selectedFile();
    if (!file) return;
    if (
      button === MouseButton.LEFT &&
      ctx.diffOrigin === "working" &&
      hit &&
      hit.kind !== "context"
    ) {
      if (this.snapshot !== ctx.commitDiff.diff) {
        this.rows.clear();
        this.snapshot = ctx.commitDiff.diff;
      }
      if (!ctrl && !alt) {
        this.rows.clear();
        this.rows.add(hit.rawRow);
      } else if (this.rows.has(hit.rawRow)) {
        this.rows.delete(hit.rawRow);
      } else this.rows.add(hit.rawRow);
      if (alt) {
        this.dragAnchor = hit.rawRow;
        this.dragSelecting = this.rows.has(hit.rawRow);
      }
      ctx.commitDiff.setSelectedRows(this.rows);
      ctx.paintHints();
      const count = this.rows.size;
      ctx.notify(
        count
          ? `${count} line${count === 1 ? "" : "s"} selected · Enter to ${ctx.mode === "staged" ? "unstage" : "stage"}`
          : "Line selection cleared",
      );
      return;
    }
    if (button !== MouseButton.RIGHT) return;
    if (
      ctx.diffOrigin === "working" &&
      hit &&
      hit.kind !== "context" &&
      (!this.rows.size || !this.rows.has(hit.rawRow))
    ) {
      this.rows.clear();
      this.rows.add(hit.rawRow);
      this.snapshot = ctx.commitDiff.diff;
      ctx.commitDiff.setSelectedRows(this.rows);
      ctx.paintHints();
    }
    if (
      ctx.diffOrigin === "working" &&
      this.rows.size &&
      this.snapshot === ctx.commitDiff.diff
    ) {
      const action =
        ctx.mode === "staged" ? "Unstage selected" : "Stage selected";
      const items = [
        { label: action },
        ...(ctx.mode === "unstaged"
          ? [{ label: "Discard selected", destructive: true }]
          : []),
        { label: "Clear selection" },
      ];
      ctx.openPopup("Selected lines", items, x, y, (item) => {
        if (item.label === "Clear selection") this.clear();
        else if (item.label === "Discard selected") void this.apply(true);
        else void this.apply();
      });
      return;
    }
    if (!hit) return;
    const selected = ctx.selectedCommit();
    let sha: string;
    let path = file.path;
    if (ctx.diffOrigin === "commit" && selected) {
      sha =
        hit.side === "old"
          ? (ctx.comparisonBaseSha ?? selected.parents[0] ?? "")
          : selected.sha;
      if (hit.side === "old") path = file.originalPath ?? file.path;
    } else if (hit.kind !== "added") {
      sha = ctx.headSha ?? "";
      path = file.originalPath ?? file.path;
    } else {
      ctx.notify("Uncommitted added lines cannot be blamed");
      return;
    }
    ctx.openGraphMenu(x, y, {
      sha,
      file: { ...file, path },
      fileStaged: ctx.mode === "staged",
      line:
        ctx.diffOrigin !== "commit" && hit.kind === "context"
          ? (hit.oldLine ?? hit.line)
          : hit.line,
    });
  }

  drag(x: number, y: number) {
    const ctx = this.context();
    if (this.dragAnchor === undefined || this.snapshot !== ctx.commitDiff.diff)
      return false;
    const hit = ctx.commitDiff.lineTargetAt(x, y);
    if (!hit) return true;
    for (const row of changedDiffRowsInRange(
      ctx.commitDiff.diff,
      this.dragAnchor,
      hit.rawRow,
    )) {
      if (this.dragSelecting) this.rows.add(row);
      else this.rows.delete(row);
    }
    ctx.commitDiff.setSelectedRows(this.rows);
    ctx.paintHints();
    return true;
  }

  dragEnd() {
    const active = this.dragAnchor !== undefined;
    this.dragAnchor = undefined;
    return active;
  }

  clear(notify = true) {
    const ctx = this.context();
    this.dragEnd();
    this.rows.clear();
    this.snapshot = "";
    ctx.commitDiff.setSelectedRows(this.rows);
    ctx.paintHints();
    if (notify) ctx.notify("Line selection cleared");
  }

  apply(discard = false) {
    const ctx = this.context();
    if (
      ctx.diffOrigin !== "working" ||
      !this.rows.size ||
      this.snapshot !== ctx.commitDiff.diff
    ) {
      this.clear();
      return;
    }
    const patch = selectPatchLines(
      this.snapshot,
      this.rows,
      discard || ctx.mode === "staged" ? "new" : "old",
    );
    if (!patch) return ctx.notify("No changed lines selected", "error");
    const staged = ctx.mode === "staged";
    const label = discard
      ? "Discarding selected lines…"
      : `${staged ? "Unstaging" : "Staging"} selected lines…`;
    this.rows.clear();
    this.snapshot = "";
    return ctx.perform(
      label,
      () =>
        discard
          ? ctx.repository.discardPatch(patch)
          : ctx.repository.applyPatch(patch, staged),
      false,
      "working",
    );
  }
}
