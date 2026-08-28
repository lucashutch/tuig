export type FileState =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface ChangedFile {
  path: string;
  originalPath?: string;
  state: FileState;
  staged: boolean;
  unstaged: boolean;
  submodule?: string;
}

export interface BranchRef {
  name: string;
  fullName: string;
  sha: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  tracking?: string;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authoredAt: string;
  committer: string;
  committerEmail: string;
  committedAt: string;
  subject: string;
  body?: string;
  decorations: string[];
}

export type ResetMode = "soft" | "mixed" | "hard";

export interface Stash {
  ref: string;
  sha: string;
  createdAt: string;
  subject: string;
}

export interface Worktree {
  path: string;
  sha: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
}

export interface Submodule {
  /** The submodule's name from .gitmodules, when configured. */
  name?: string;
  path: string;
  sha: string;
  state: "clean" | "uninitialized" | "different" | "conflicted";
  description?: string;
}

export interface RepositorySnapshot {
  root: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  branches: BranchRef[];
  stashes: Stash[];
  worktrees: Worktree[];
  submodules: Submodule[];
  commits: Commit[];
}

export interface DiffRequest {
  path?: string;
  staged?: boolean;
  commit?: string;
  context?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRepository {
  readonly root: string;
  remoteUrl?(): Promise<string | undefined>;
  snapshot(limit?: number): Promise<RepositorySnapshot>;
  diff(request: DiffRequest): Promise<string>;
  commitFiles(sha: string): Promise<ChangedFile[]>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  applyPatch(patch: string, reverse?: boolean): Promise<void>;
  discardAll(): Promise<void>;
  /** Restores the given paths in the working tree, dropping unstaged edits. */
  discard(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  amendCommit(message: string): Promise<void>;
  rewordCommit(sha: string, message: string): Promise<void>;
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
  /** Creates a lightweight tag at target (or HEAD when omitted). */
  createTag(name: string, target?: string): Promise<void>;
  createBranch(
    name: string,
    startPoint?: string,
    checkout?: boolean,
  ): Promise<void>;
  deleteBranch(name: string, force?: boolean, remote?: boolean): Promise<void>;
  fetch(remote?: string, signal?: AbortSignal): Promise<void>;
  pull(rebase?: boolean, signal?: AbortSignal): Promise<void>;
  push(
    remote?: string,
    setUpstream?: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
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
}
