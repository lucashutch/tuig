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
  subject: string;
  body?: string;
  decorations: string[];
}

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
  snapshot(limit?: number): Promise<RepositorySnapshot>;
  diff(request: DiffRequest): Promise<string>;
  commitFiles(sha: string): Promise<ChangedFile[]>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  applyPatch(patch: string, reverse?: boolean): Promise<void>;
  commit(message: string): Promise<void>;
  switchBranch(name: string): Promise<void>;
  createBranch(
    name: string,
    startPoint?: string,
    checkout?: boolean,
  ): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
  fetch(remote?: string): Promise<void>;
  pull(rebase?: boolean): Promise<void>;
  push(remote?: string, setUpstream?: boolean): Promise<void>;
  stash(message?: string, includeUntracked?: boolean): Promise<void>;
  applyStash(ref: string, pop?: boolean): Promise<void>;
  dropStash(ref: string): Promise<void>;
  addWorktree(
    path: string,
    branch?: string,
    createBranch?: boolean,
  ): Promise<void>;
  removeWorktree(path: string, force?: boolean): Promise<void>;
}
