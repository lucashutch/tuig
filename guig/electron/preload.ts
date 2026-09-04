import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc.js";
import type { GuigApi } from "../shared/ipc.js";

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
