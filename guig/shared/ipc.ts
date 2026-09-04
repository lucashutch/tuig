import type {
  ChangedFile,
  CommitPage,
  DiffRequest,
  RepositorySnapshot,
  ResetMode,
  WorkingStatus,
} from "./types.js";

/** IPC channel names for the guig backend. */
export const IPC = {
  openRepo: "guig:open-repo",
  snapshot: "guig:snapshot",
  commitPage: "guig:commit-page",
  workingStatus: "guig:working-status",
  diff: "guig:diff",
  commitFiles: "guig:commit-files",
  stage: "guig:stage",
  unstage: "guig:unstage",
  applyPatch: "guig:apply-patch",
  discard: "guig:discard",
  discardAll: "guig:discard-all",
  commit: "guig:commit",
  amend: "guig:amend",
  reword: "guig:reword",
  switchBranch: "guig:switch-branch",
  checkoutCommit: "guig:checkout-commit",
  checkoutRemoteBranch: "guig:checkout-remote-branch",
  resetTo: "guig:reset-to",
  rebaseOnto: "guig:rebase-onto",
  cherryPick: "guig:cherry-pick",
  createBranch: "guig:create-branch",
  createTag: "guig:create-tag",
  deleteBranch: "guig:delete-branch",
  fetch: "guig:fetch",
  pull: "guig:pull",
  push: "guig:push",
  cancelNetwork: "guig:cancel-network",
  stash: "guig:stash",
  applyStash: "guig:apply-stash",
  popStash: "guig:pop-stash",
  dropStash: "guig:drop-stash",
  addWorktree: "guig:add-worktree",
  removeWorktree: "guig:remove-worktree",
  lockWorktree: "guig:lock-worktree",
  remoteUrl: "guig:remote-url",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface OpenRepoRequest {
  path?: string;
}

export interface CommitPageRequest {
  limit: number;
  skip?: number;
}

export interface ApplyPatchRequest {
  patch: string;
  reverse?: boolean;
}

export interface RewordRequest {
  sha: string;
  message: string;
}

export interface CheckoutRemoteBranchRequest {
  local: string;
  remote: string;
  reset?: boolean;
}

export interface ResetRequest {
  sha: string;
  mode?: ResetMode;
}

export interface CreateBranchRequest {
  name: string;
  startPoint?: string;
  checkout?: boolean;
}

export interface CreateTagRequest {
  name: string;
  target?: string;
}

export interface DeleteBranchRequest {
  name: string;
  force?: boolean;
  remote?: boolean;
}

export interface StashRequest {
  message?: string;
  includeUntracked?: boolean;
}

export interface ApplyStashRequest {
  ref: string;
  pop?: boolean;
}

export interface AddWorktreeRequest {
  path: string;
  branch?: string;
  createBranch?: boolean;
}

export interface RemoveWorktreeRequest {
  path: string;
  force?: boolean;
}

export interface LockWorktreeRequest {
  path: string;
  lock?: boolean;
  reason?: string;
}

/** Renderer-facing backend API, exposed as `window.guig` by the preload. */
export interface GuigApi {
  openRepo(path?: string): Promise<string>;
  snapshot(limit?: number): Promise<RepositorySnapshot>;
  commitPage(limit: number, skip?: number): Promise<CommitPage>;
  workingStatus(): Promise<WorkingStatus>;
  diff(request: DiffRequest): Promise<string>;
  commitFiles(sha: string): Promise<ChangedFile[]>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  applyPatch(patch: string, reverse?: boolean): Promise<void>;
  discard(paths: string[]): Promise<void>;
  discardAll(): Promise<void>;
  commit(message: string): Promise<void>;
  amend(message: string): Promise<void>;
  reword(sha: string, message: string): Promise<void>;
  switchBranch(name: string): Promise<void>;
  checkoutCommit(sha: string): Promise<void>;
  checkoutRemoteBranch(
    local: string,
    remote: string,
    reset?: boolean,
  ): Promise<void>;
  resetTo(sha: string, mode?: ResetMode): Promise<void>;
  rebaseOnto(ref: string): Promise<void>;
  cherryPick(sha: string): Promise<void>;
  createBranch(
    name: string,
    startPoint?: string,
    checkout?: boolean,
  ): Promise<void>;
  createTag(name: string, target?: string): Promise<void>;
  deleteBranch(name: string, force?: boolean, remote?: boolean): Promise<void>;
  fetch(remote?: string): Promise<void>;
  pull(rebase?: boolean): Promise<void>;
  push(remote?: string, setUpstream?: boolean): Promise<void>;
  /** Aborts an in-flight fetch, pull, or push. */
  cancelNetwork(): Promise<void>;
  stash(message?: string, includeUntracked?: boolean): Promise<void>;
  applyStash(ref: string, pop?: boolean): Promise<void>;
  popStash(ref: string): Promise<void>;
  dropStash(ref: string): Promise<void>;
  addWorktree(
    path: string,
    branch?: string,
    createBranch?: boolean,
  ): Promise<void>;
  removeWorktree(path: string, force?: boolean): Promise<void>;
  lockWorktree(path: string, lock?: boolean, reason?: string): Promise<void>;
  remoteUrl(): Promise<string | undefined>;
}
