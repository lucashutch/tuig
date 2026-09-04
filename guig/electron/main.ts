import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitRepositoryService } from "./git.js";
import { IPC } from "../shared/ipc.js";
import type {
  AddWorktreeRequest,
  ApplyPatchRequest,
  ApplyStashRequest,
  CheckoutRemoteBranchRequest,
  CommitPageRequest,
  CreateBranchRequest,
  CreateTagRequest,
  DeleteBranchRequest,
  LockWorktreeRequest,
  OpenRepoRequest,
  RemoveWorktreeRequest,
  ResetRequest,
  RewordRequest,
  StashRequest,
} from "../shared/ipc.js";
import type { DiffRequest, ResetMode } from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let repo: GitRepositoryService | null = null;
/** Abort controller for the in-flight fetch, pull, or push, if any. */
let networkController: AbortController | null = null;

function requireRepo(): GitRepositoryService {
  if (!repo) throw new Error("No repository open");
  return repo;
}

/** Runs a network op with cancellation via the cancelNetwork channel. */
async function withNetwork(
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  networkController?.abort();
  const controller = new AbortController();
  networkController = controller;
  try {
    await run(controller.signal);
  } finally {
    if (networkController === controller) networkController = null;
  }
}

function registerGitHandlers(): void {
  ipcMain.handle(
    IPC.openRepo,
    async (_event: IpcMainInvokeEvent, req: OpenRepoRequest = {}) => {
      let path = req.path;
      if (!path && mainWindow) {
        const picked = await dialog.showOpenDialog(mainWindow, {
          properties: ["openDirectory"],
        });
        if (picked.canceled || !picked.filePaths[0])
          throw new Error("No repository selected");
        path = picked.filePaths[0];
      }
      repo?.dispose();
      repo = await GitRepositoryService.open(path ?? process.cwd());
      return repo.root;
    },
  );
  ipcMain.handle(IPC.snapshot, (_event: IpcMainInvokeEvent, limit?: number) =>
    requireRepo().snapshot(limit ?? undefined),
  );
  ipcMain.handle(
    IPC.commitPage,
    (_event: IpcMainInvokeEvent, req: CommitPageRequest) =>
      requireRepo().commitPage(req.limit, req.skip),
  );
  ipcMain.handle(IPC.workingStatus, () => requireRepo().workingStatus());
  ipcMain.handle(IPC.diff, (_event: IpcMainInvokeEvent, req: DiffRequest) =>
    requireRepo().diff(req),
  );
  ipcMain.handle(IPC.commitFiles, (_event: IpcMainInvokeEvent, sha: string) =>
    requireRepo().commitFiles(sha),
  );
  ipcMain.handle(IPC.stage, (_event: IpcMainInvokeEvent, paths: string[]) =>
    requireRepo().stage(paths),
  );
  ipcMain.handle(IPC.unstage, (_event: IpcMainInvokeEvent, paths: string[]) =>
    requireRepo().unstage(paths),
  );
  ipcMain.handle(
    IPC.applyPatch,
    (_event: IpcMainInvokeEvent, req: ApplyPatchRequest) =>
      requireRepo().applyPatch(req.patch, req.reverse),
  );
  ipcMain.handle(IPC.discard, (_event: IpcMainInvokeEvent, paths: string[]) =>
    requireRepo().discard(paths),
  );
  ipcMain.handle(IPC.discardAll, () => requireRepo().discardAll());
  ipcMain.handle(IPC.commit, (_event: IpcMainInvokeEvent, message: string) =>
    requireRepo().commit(message),
  );
  ipcMain.handle(IPC.amend, (_event: IpcMainInvokeEvent, message: string) =>
    requireRepo().amendCommit(message),
  );
  ipcMain.handle(IPC.reword, (_event: IpcMainInvokeEvent, req: RewordRequest) =>
    requireRepo().rewordCommit(req.sha, req.message),
  );
  ipcMain.handle(IPC.switchBranch, (_event: IpcMainInvokeEvent, name: string) =>
    requireRepo().switchBranch(name),
  );
  ipcMain.handle(
    IPC.checkoutCommit,
    (_event: IpcMainInvokeEvent, sha: string) =>
      requireRepo().checkoutCommit(sha),
  );
  ipcMain.handle(
    IPC.checkoutRemoteBranch,
    (_event: IpcMainInvokeEvent, req: CheckoutRemoteBranchRequest) =>
      requireRepo().checkoutRemoteBranch(req.local, req.remote, req.reset),
  );
  ipcMain.handle(IPC.resetTo, (_event: IpcMainInvokeEvent, req: ResetRequest) =>
    requireRepo().resetTo(req.sha, req.mode as ResetMode | undefined),
  );
  ipcMain.handle(IPC.rebaseOnto, (_event: IpcMainInvokeEvent, ref: string) =>
    requireRepo().rebaseOnto(ref),
  );
  ipcMain.handle(IPC.cherryPick, (_event: IpcMainInvokeEvent, sha: string) =>
    requireRepo().cherryPick(sha),
  );
  ipcMain.handle(
    IPC.createBranch,
    (_event: IpcMainInvokeEvent, req: CreateBranchRequest) =>
      requireRepo().createBranch(req.name, req.startPoint, req.checkout),
  );
  ipcMain.handle(
    IPC.createTag,
    (_event: IpcMainInvokeEvent, req: CreateTagRequest) =>
      requireRepo().createTag(req.name, req.target),
  );
  ipcMain.handle(
    IPC.deleteBranch,
    (_event: IpcMainInvokeEvent, req: DeleteBranchRequest) =>
      requireRepo().deleteBranch(req.name, req.force, req.remote),
  );
  ipcMain.handle(IPC.fetch, (_event: IpcMainInvokeEvent, remote?: string) =>
    withNetwork((signal) => requireRepo().fetch(remote, signal)),
  );
  ipcMain.handle(IPC.pull, (_event: IpcMainInvokeEvent, rebase?: boolean) =>
    withNetwork((signal) => requireRepo().pull(rebase, signal)),
  );
  ipcMain.handle(
    IPC.push,
    (
      _event: IpcMainInvokeEvent,
      req: { remote?: string; setUpstream?: boolean },
    ) =>
      withNetwork((signal) =>
        requireRepo().push(req.remote, req.setUpstream, signal),
      ),
  );
  ipcMain.handle(IPC.cancelNetwork, () => {
    networkController?.abort();
    networkController = null;
  });
  ipcMain.handle(
    IPC.stash,
    (_event: IpcMainInvokeEvent, req: StashRequest = {}) =>
      requireRepo().stash(req.message, req.includeUntracked),
  );
  ipcMain.handle(
    IPC.applyStash,
    (_event: IpcMainInvokeEvent, req: ApplyStashRequest) =>
      requireRepo().applyStash(req.ref, req.pop),
  );
  ipcMain.handle(IPC.popStash, (_event: IpcMainInvokeEvent, ref: string) =>
    requireRepo().popStash(ref),
  );
  ipcMain.handle(IPC.dropStash, (_event: IpcMainInvokeEvent, ref: string) =>
    requireRepo().dropStash(ref),
  );
  ipcMain.handle(
    IPC.addWorktree,
    (_event: IpcMainInvokeEvent, req: AddWorktreeRequest) =>
      requireRepo().addWorktree(req.path, req.branch, req.createBranch),
  );
  ipcMain.handle(
    IPC.removeWorktree,
    (_event: IpcMainInvokeEvent, req: RemoveWorktreeRequest) =>
      requireRepo().removeWorktree(req.path, req.force),
  );
  ipcMain.handle(
    IPC.lockWorktree,
    (_event: IpcMainInvokeEvent, req: LockWorktreeRequest) =>
      requireRepo().lockWorktree(req.path, req.lock, req.reason),
  );
  ipcMain.handle(IPC.remoteUrl, () => requireRepo().remoteUrl());
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(here, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    // `build:electron` emits next to the frontend bundle under dist/.
    await mainWindow.loadFile(join(here, "../frontend/index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

await app.whenReady();
registerGitHandlers();
await createWindow();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
