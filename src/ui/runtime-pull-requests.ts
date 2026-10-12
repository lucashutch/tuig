// Pull request runtime glue: loading per tab, refresh timing, spinner, and row actions.
import type {
  PullRequest,
  PullRequestList,
  PullRequestService,
} from "../git/pull-request-types.js";
import type { RepositorySnapshot } from "../git/types.js";
import { openUrl as openUrlInBrowser, type UrlOpener } from "../open-url.js";
import {
  UNSETTLED_CHECKS,
  pullRequestBranch,
  pullRequestCommitIndex,
  pullRequestPanel,
  type PullRequestCommitIndex,
  type PullRequestPanel,
} from "./pull-requests.js";
import {
  BRAILLE_SPINNER_FRAMES,
  createBrailleSpinner,
  type BrailleSpinnerScheduler,
} from "./runtime-notifications.js";

/** Creates the pull request service for one repository root. */
export type PullRequestServiceFactory = (root: string) => PullRequestService;

/** Re-list interval while some check can still change. */
export const PULL_REQUEST_ACTIVE_REFRESH_MS = 60_000;
/** Re-list interval while every check has settled. */
export const PULL_REQUEST_IDLE_REFRESH_MS = 180_000;
/** Delay before re-listing after a push or fetch, so GitHub sees the change. */
export const PULL_REQUEST_AFTER_SYNC_MS = 3_000;

export interface PullRequestTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: PullRequestTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RuntimePullRequestsOptions {
  /** Without a factory the feature is off and every pull request view hides. */
  factory?: PullRequestServiceFactory;
  openUrl?: UrlOpener;
  timers?: PullRequestTimers;
  spinnerScheduler?: BrailleSpinnerScheduler;
}

export interface RuntimePullRequestsContext {
  readonly repository: { root: string };
  snapshot?: RepositorySnapshot;
  leftCollapsed: boolean;
  paintSidebar(): void;
  paintHistory(): void;
  notify(text: string, tone?: "info" | "error" | "busy"): void;
  /** Select a commit in the history graph without checking it out. */
  focusCommit(sha: string): Promise<boolean>;
}

type SpinnerArea = "sidebar" | "history";

/**
 * Owns the pull request list of the active tab.
 *
 * A tab switch aborts the previous request and bumps a request number, so a
 * slow answer for an earlier tab can never replace the newer tab's list.
 */
export class RuntimePullRequestsController {
  private result?: PullRequestList;
  private request = 0;
  private abort?: AbortController;
  private timer?: unknown;
  private disposed = false;
  private readonly services = new Map<string, PullRequestService>();
  private readonly timers: PullRequestTimers;
  private readonly openUrl: UrlOpener;
  private frame: string = BRAILLE_SPINNER_FRAMES[0];
  private readonly spinning: Record<SpinnerArea, boolean> = {
    sidebar: false,
    history: false,
  };
  private readonly spinner;
  private index?: {
    pullRequests: readonly PullRequest[];
    branches: RepositorySnapshot["branches"];
    value: PullRequestCommitIndex;
  };

  constructor(
    private readonly context: RuntimePullRequestsContext,
    private readonly options: RuntimePullRequestsOptions = {},
  ) {
    this.timers = options.timers ?? defaultTimers;
    this.openUrl = options.openUrl ?? openUrlInBrowser;
    this.spinner = createBrailleSpinner((frame) => {
      // start() renders the first frame at once, often from inside a paint.
      // Only later frames need a repaint.
      if (frame === this.frame) return;
      this.frame = frame;
      if (this.spinning.sidebar) this.context.paintSidebar();
      if (this.spinning.history) this.context.paintHistory();
    }, options.spinnerScheduler);
  }

  get enabled() {
    return Boolean(this.options.factory);
  }

  /** What the sidebar section shows. */
  get panel(): PullRequestPanel {
    return pullRequestPanel(this.enabled, this.result);
  }

  /** Current spinner glyph for running checks. */
  get spinnerFrame() {
    return this.frame;
  }

  /** Every open pull request, or none while the list is unavailable. */
  get pullRequests(): readonly PullRequest[] {
    return this.result?.available ? this.result.pullRequests : [];
  }

  /** True when the history PR column has data to show. */
  get columnAvailable() {
    return this.pullRequests.length > 0;
  }

  /** Row matcher for the history PR column, rebuilt when its inputs change. */
  get columnIndex(): PullRequestCommitIndex | undefined {
    const branches = this.context.snapshot?.branches;
    if (!branches || !this.columnAvailable) return undefined;
    const pullRequests = this.pullRequests;
    if (
      this.index?.pullRequests !== pullRequests ||
      this.index.branches !== branches
    )
      this.index = {
        pullRequests,
        branches,
        value: pullRequestCommitIndex(pullRequests, branches),
      };
    return this.index.value;
  }

  /**
   * Painters report whether they drew running checks. The spinner runs only
   * while one of them did, so no timer runs when nothing is animating.
   */
  spinnerShown(area: SpinnerArea, running: boolean) {
    this.spinning[area] =
      running && !(area === "sidebar" && this.context.leftCollapsed);
    if (!this.disposed && (this.spinning.sidebar || this.spinning.history))
      this.spinner.start();
    else {
      this.spinner.stop();
      this.frame = BRAILLE_SPINNER_FRAMES[0];
    }
  }

  /** Start over for the active tab's repository. */
  activate() {
    this.cancel();
    this.result = undefined;
    this.index = undefined;
    if (!this.enabled || this.disposed) return;
    void this.load();
  }

  /** Re-list now, keeping the current list on screen until the answer. */
  refresh() {
    this.cancel();
    if (!this.enabled || this.disposed) return Promise.resolve();
    return this.load();
  }

  /** Re-list shortly, for example after a push or fetch. */
  refreshSoon() {
    if (!this.enabled || this.disposed) return;
    this.schedule(PULL_REQUEST_AFTER_SYNC_MS);
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.spinner.stop();
  }

  /** Jump to the pull request's head in the graph without a checkout. */
  async select(pullRequest: PullRequest) {
    const snapshot = this.context.snapshot;
    if (!snapshot) return;
    const branch = pullRequestBranch(pullRequest, snapshot.branches);
    if (branch && (await this.context.focusCommit(branch.sha))) return;
    const headSha = pullRequest.headSha;
    // A head commit outside the loaded history would need an unbounded walk,
    // so only a commit already on screen is used.
    if (
      headSha &&
      snapshot.commits.some((commit) => commit.sha === headSha) &&
      (await this.context.focusCommit(headSha))
    )
      return;
    this.context.notify(`Branch for #${pullRequest.number} is not fetched`);
  }

  open(pullRequest: PullRequest) {
    return this.openUrl(pullRequest.url).catch(() =>
      this.context.notify(
        `Could not open #${pullRequest.number} in a browser`,
        "error",
      ),
    );
  }

  /** The open pull request whose head is the checked-out branch. */
  forCurrentBranch(): PullRequest | undefined {
    const snapshot = this.context.snapshot;
    if (!snapshot) return undefined;
    const current = snapshot.branches.find(
      (branch) => branch.current && !branch.remote,
    );
    return [...this.pullRequests]
      .sort((a, b) => b.number - a.number)
      .find(
        (pr) =>
          (current && pullRequestBranch(pr, snapshot.branches) === current) ||
          (pr.headSha !== undefined && pr.headSha === snapshot.headSha),
      );
  }

  openForCurrentBranch() {
    const pullRequest = this.forCurrentBranch();
    if (pullRequest) return this.open(pullRequest);
    this.context.notify("No open pull request for the current branch");
    return Promise.resolve();
  }

  private cancel() {
    this.request++;
    this.abort?.abort();
    this.abort = undefined;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number) {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.refresh();
    }, delayMs);
  }

  private async load() {
    const root = this.context.repository.root;
    const request = this.request;
    const abort = new AbortController();
    this.abort = abort;
    let result: PullRequestList;
    try {
      result = await this.service(root).list(abort.signal);
    } catch (error) {
      result = {
        available: false,
        reason: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (request !== this.request || this.disposed) return;
    this.abort = undefined;
    this.result = result;
    this.schedule(
      this.pullRequests.some((pr) => UNSETTLED_CHECKS.has(pr.checks))
        ? PULL_REQUEST_ACTIVE_REFRESH_MS
        : PULL_REQUEST_IDLE_REFRESH_MS,
    );
    this.context.paintSidebar();
    this.context.paintHistory();
  }

  private service(root: string) {
    let service = this.services.get(root);
    if (!service) {
      service = this.options.factory!(root);
      this.services.set(root, service);
    }
    return service;
  }
}
