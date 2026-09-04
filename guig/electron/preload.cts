// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");
import type { GuigApi } from "../shared/ipc.js";

/**
 * Channel names for the guig backend. Sandboxed preload scripts always load
 * as CommonJS, so this file is `.cts` (compiled to `preload.cjs`) and cannot
 * value-import `../shared/ipc.js`, which ships as ESM for the main process.
 * This map is a copy of `IPC` there; `tests/guig-ipc-sync.test.ts` fails when
 * the two drift apart.
 */
const IPC = {
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

const guig: GuigApi = {
  openRepo: (path) => ipcRenderer.invoke(IPC.openRepo, { path }),
  snapshot: (limit) => ipcRenderer.invoke(IPC.snapshot, limit),
  commitPage: (limit, skip) =>
    ipcRenderer.invoke(IPC.commitPage, { limit, skip }),
  workingStatus: () => ipcRenderer.invoke(IPC.workingStatus),
  diff: (request) => ipcRenderer.invoke(IPC.diff, request),
  commitFiles: (sha) => ipcRenderer.invoke(IPC.commitFiles, sha),
  stage: (paths) => ipcRenderer.invoke(IPC.stage, paths),
  unstage: (paths) => ipcRenderer.invoke(IPC.unstage, paths),
  applyPatch: (patch, reverse) =>
    ipcRenderer.invoke(IPC.applyPatch, { patch, reverse }),
  discard: (paths) => ipcRenderer.invoke(IPC.discard, paths),
  discardAll: () => ipcRenderer.invoke(IPC.discardAll),
  commit: (message) => ipcRenderer.invoke(IPC.commit, message),
  amend: (message) => ipcRenderer.invoke(IPC.amend, message),
  reword: (sha, message) => ipcRenderer.invoke(IPC.reword, { sha, message }),
  switchBranch: (name) => ipcRenderer.invoke(IPC.switchBranch, name),
  checkoutCommit: (sha) => ipcRenderer.invoke(IPC.checkoutCommit, sha),
  checkoutRemoteBranch: (local, remote, reset) =>
    ipcRenderer.invoke(IPC.checkoutRemoteBranch, { local, remote, reset }),
  resetTo: (sha, mode) => ipcRenderer.invoke(IPC.resetTo, { sha, mode }),
  rebaseOnto: (ref) => ipcRenderer.invoke(IPC.rebaseOnto, ref),
  cherryPick: (sha) => ipcRenderer.invoke(IPC.cherryPick, sha),
  createBranch: (name, startPoint, checkout) =>
    ipcRenderer.invoke(IPC.createBranch, { name, startPoint, checkout }),
  createTag: (name, target) =>
    ipcRenderer.invoke(IPC.createTag, { name, target }),
  deleteBranch: (name, force, remote) =>
    ipcRenderer.invoke(IPC.deleteBranch, { name, force, remote }),
  fetch: (remote) => ipcRenderer.invoke(IPC.fetch, remote),
  pull: (rebase) => ipcRenderer.invoke(IPC.pull, rebase),
  push: (remote, setUpstream) =>
    ipcRenderer.invoke(IPC.push, { remote, setUpstream }),
  cancelNetwork: () => ipcRenderer.invoke(IPC.cancelNetwork),
  stash: (message, includeUntracked) =>
    ipcRenderer.invoke(IPC.stash, { message, includeUntracked }),
  applyStash: (ref, pop) => ipcRenderer.invoke(IPC.applyStash, { ref, pop }),
  popStash: (ref) => ipcRenderer.invoke(IPC.popStash, ref),
  dropStash: (ref) => ipcRenderer.invoke(IPC.dropStash, ref),
  addWorktree: (path, branch, createBranch) =>
    ipcRenderer.invoke(IPC.addWorktree, { path, branch, createBranch }),
  removeWorktree: (path, force) =>
    ipcRenderer.invoke(IPC.removeWorktree, { path, force }),
  lockWorktree: (path, lock, reason) =>
    ipcRenderer.invoke(IPC.lockWorktree, { path, lock, reason }),
  remoteUrl: () => ipcRenderer.invoke(IPC.remoteUrl),
};

contextBridge.exposeInMainWorld("guig", guig);

declare global {
  interface Window {
    guig: GuigApi;
  }
}
