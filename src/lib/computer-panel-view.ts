export type ComputerPanelView = "computer" | "android" | "browser" | "routines" | "files" | "data";

/** The tab a stored selection resolves to once the mode and connected devices
 * decide which triggers exist; it never resolves to a view without a trigger. */
export function resolveComputerPanelView(
  view: ComputerPanelView,
  { advanced, androidConnected }: { advanced: boolean; androidConnected: boolean },
): ComputerPanelView {
  if (!advanced) return view === "routines" || view === "android" ? "computer" : view;
  return view === "files" || (view === "android" && !androidConnected) ? "computer" : view;
}

const STORAGE_PREFIX = "omb-computer-panel-view";

function storageKey(botId: string): string {
  return `${STORAGE_PREFIX}:${botId}`;
}

export function readComputerPanelView(
  botId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): ComputerPanelView {
  try {
    const value = storage.getItem(storageKey(botId));
    if (value === "android" || value === "browser" || value === "routines" || value === "files" || value === "data") return value;
  } catch {
  }
  return "computer";
}

export function writeComputerPanelView(
  botId: string,
  view: ComputerPanelView,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(storageKey(botId), view);
  } catch {
  }
}
