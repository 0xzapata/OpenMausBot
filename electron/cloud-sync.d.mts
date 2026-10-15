export interface CloudSyncDisk { totalBytes: number; freeBytes: number; syncedBytes: number; botFileBytes: number; trashBytes: number; reserveBytes: number; usedBytes: number; planMaxBytes: number; warn: boolean }
export interface CloudSyncStatus {
  enabled: boolean;
  openAtLogin?: boolean;
  phase: "off" | "syncing" | "synced" | "waiting" | "offline" | "signed-out";
  lastSyncedAt: number | null;
  disk: CloudSyncDisk | null;
  folders: Array<{ id: string; kind: "pc" | "bot"; local: string; cloudPath: string }>;
  waiting: Array<{ folderId: string; path: string; size: number; toThisComputer?: boolean }>;
  clashes: Array<{ folderId: string; path: string; clashPath: string }>;
  held: Array<{ folderId: string; path: string; reason: "windows-name" | "case-clash" }>;
  problems: Array<{ folderId: string; path: string; error: string }>;
  notices: Array<{ folderId: string; path: string }>;
  missing: string[];
}
export interface CloudSyncTrashEntry { id: string; folderId: string; path: string; size: number; deletedAt: number }
export interface CloudSyncBridge {
  state(): Promise<CloudSyncStatus>;
  set(input: { enabled?: boolean; keepCloudCopy?: boolean; openAtLogin?: boolean }): Promise<CloudSyncStatus>;
  trash(): Promise<CloudSyncTrashEntry[]>;
  restore(entryId: string): Promise<CloudSyncStatus>;
  open(input: { folderId: string; path: string }): Promise<void>;
  upgrade(): Promise<void>;
  onState(callback: (state: CloudSyncStatus) => void): () => void;
}
export declare function linkedFolders(input: { bots?: Array<{ id: string; cwd?: string; tasks?: Array<{ cwd?: string }> }>; groups?: Array<{ id: string; cwd?: string }>; localDataDir: string; homeDir: string; platform?: NodeJS.Platform }): { links: Array<{ pcPath: string; bots: string[]; rooms: string[] }>; refused: Array<{ pcPath: string; reason: "too-broad" }> };
export declare function createCloudSyncService(options: Record<string, unknown>): {
  start(): void;
  pass(only?: Set<string> | null): Promise<void>;
  state(): CloudSyncStatus;
  setEnabled(on: boolean, options?: { keepCloudCopy?: boolean }): Promise<CloudSyncStatus>;
  linkFolder(pcPath: string): Promise<{ cloudPath: string }>;
  trash(): Promise<CloudSyncTrashEntry[]>;
  restore(entryId: string): Promise<CloudSyncStatus>;
  localPath(folderId: string, path: string): string | null;
  wake(): void;
  close(): void;
};
