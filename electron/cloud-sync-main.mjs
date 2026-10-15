// Wires Sync with My Cloud into the desktop app: the service with Electron's pieces, its Settings channels (this
// computer's own window only), Choose on this PC for the My Cloud page, the tray item and Open MausBot when I log in.
import path from "node:path";
import { createCloudSyncService } from "./cloud-sync.mjs";
import { createCloudSyncIndicator } from "./cloud-sync-indicator.mjs";

export function installCloudSync({
  app, ipcMain, dialog, shell, powerMonitor, Tray, Menu, nativeImage, iconPath, fetch,
  localWorkspaceOnly, cloudPageSender, send, cloudOrigin, localBots, cloudAccount, planDisk, localDataDir, openSettings,
}) {
  const dir = path.join(app.getPath("userData"), "cloud-sync");
  const indicator = createCloudSyncIndicator({ Tray, Menu, nativeImage, iconPath, onOpen: openSettings });
  const openAtLogin = () => app.getLoginItemSettings().openAtLogin === true;
  const setOpenAtLogin = (on) => app.setLoginItemSettings({ openAtLogin: on });
  const service = createCloudSyncService({
    settingsFile: path.join(dir, "settings.json"), stateFile: path.join(dir, "state.db"),
    documentsDir: app.getPath("documents"), localDataDir, cloudOrigin, fetch, localBots,
    growDisk: (sizeGb) => cloudAccount().growDisk(sizeGb), planDisk, trashItem: (file) => shell.trashItem(file),
    onChange: (state) => { send("sync:state-changed", { ...state, openAtLogin: openAtLogin() }); indicator.update(state); },
  });
  const snapshot = () => ({ ...service.state(), openAtLogin: openAtLogin() });
  ipcMain.handle("sync:state", localWorkspaceOnly("sync:state", () => snapshot()));
  ipcMain.handle("sync:set", localWorkspaceOnly("sync:set", async (_event, input) => {
    if (!input || typeof input !== "object") throw new Error("Invalid sync settings.");
    if (typeof input.openAtLogin === "boolean") setOpenAtLogin(input.openAtLogin);
    if (typeof input.enabled === "boolean") {
      if (input.enabled && !service.state().enabled) setOpenAtLogin(true);
      await service.setEnabled(input.enabled, { keepCloudCopy: input.keepCloudCopy !== false });
    }
    return snapshot();
  }));
  ipcMain.handle("sync:trash", localWorkspaceOnly("sync:trash", () => service.trash()));
  ipcMain.handle("sync:restore", localWorkspaceOnly("sync:restore", async (_event, entryId) => {
    if (typeof entryId !== "string" || !/^[0-9a-f-]{36}$/.test(entryId)) throw new Error("Invalid deleted file.");
    await service.restore(entryId);
    return snapshot();
  }));
  ipcMain.handle("sync:open", localWorkspaceOnly("sync:open", (_event, input) => {
    const file = service.localPath(String(input?.folderId ?? ""), String(input?.path ?? ""));
    if (file) shell.showItemInFolder(file);
  }));
  ipcMain.handle("sync:upgrade", localWorkspaceOnly("sync:upgrade", async () => { await cloudAccount().openDashboard(); }));
  ipcMain.handle("cloud-sync:link-folder", cloudPageSender("cloud-sync:link-folder", async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return service.linkFolder(picked.filePaths[0]);
  }));
  powerMonitor.on("resume", () => service.wake());
  return { start: () => service.start(), close: () => { service.close(); indicator.destroy(); } };
}
