// The tray item while Sync with My Cloud is on: one status line and a way to its settings.
const LINES = {
  syncing: "Syncing with My Cloud…",
  synced: "Synced with My Cloud",
  waiting: "Waiting: My Cloud is full",
  offline: "Offline: sync resumes when My Cloud can be reached",
  "signed-out": "Sign in to My Cloud again to keep syncing",
};

export function createCloudSyncIndicator({ Tray, Menu, nativeImage, iconPath, onOpen }) {
  let tray = null;
  let shown = "";
  return {
    update(state) {
      const line = state?.enabled ? (state.disk?.warn && state.phase === "synced" ? "My Cloud is 80% full" : LINES[state.phase] ?? "") : "";
      if (line === shown && (tray !== null) === Boolean(line)) return;
      shown = line;
      if (!line) { if (tray && !tray.isDestroyed?.()) tray.destroy?.(); tray = null; return; }
      if (!tray || tray.isDestroyed?.()) {
        tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
        tray.on?.("click", () => tray?.popUpContextMenu?.());
      }
      tray.setToolTip?.(`OpenMausBot: ${line}`);
      tray.setContextMenu?.(Menu.buildFromTemplate([{ label: line, enabled: false }, { type: "separator" }, { label: "Sync settings…", click: () => onOpen() }]));
    },
    destroy() { if (tray && !tray.isDestroyed?.()) tray.destroy?.(); tray = null; shown = ""; },
  };
}
