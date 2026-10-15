import { useEffect, useRef, useState } from "react";
import type { CloudSyncBridge, CloudSyncStatus, CloudSyncTrashEntry } from "../../electron/cloud-sync.mjs";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { Switch } from "./SettingsPrimitives";

const PHASES: Record<Exclude<CloudSyncStatus["phase"], "off">, LocaleKey> = {
  syncing: "cloudSync.status.syncing",
  synced: "cloudSync.status.synced",
  waiting: "cloudSync.status.waiting",
  offline: "cloudSync.status.offline",
  "signed-out": "cloudSync.status.signedOut",
};

export function syncStatusKey(state: CloudSyncStatus | null): LocaleKey | null {
  if (!state?.enabled || state.phase === "off") return null;
  return PHASES[state.phase];
}

export function formatSyncBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Security: main decides which Cloud and which folders; this page only shows state and passes the person's choices. */
export function CloudSync({ bridge }: { bridge: CloudSyncBridge }) {
  const [state, setState] = useState<CloudSyncStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [deleted, setDeleted] = useState<CloudSyncTrashEntry[]>([]);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void bridge.state().then((next) => { if (mounted.current) setState(next); }).catch(() => {});
    void bridge.trash().then((entries) => { if (mounted.current) setDeleted(entries); }).catch(() => {});
    const off = bridge.onState((next) => { if (mounted.current) setState(next); });
    return () => { mounted.current = false; off(); };
  }, [bridge]);
  const perform = async (action: () => Promise<CloudSyncStatus>) => {
    if (working) return;
    setWorking(true);
    setFailed(null);
    try { const next = await action(); if (mounted.current) setState(next); }
    catch (error) { if (mounted.current) setFailed(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setWorking(false); }
  };
  const on = state?.enabled === true;
  const status = syncStatusKey(state);
  const disk = state?.disk ?? null;
  const waitingBytes = (state?.waiting ?? []).reduce((sum, item) => sum + item.size, 0);
  return <section className="flex w-full flex-col gap-2 border-t border-line pt-3" aria-label={t("cloudSync.title")}>
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-[14px] text-ink">{t("cloudSync.title")}</span>
        <p className="text-[12px] text-ink-secondary">{t("cloudSync.help")}</p>
        <p className="text-[12px] text-ink-secondary">{t("cloudSync.everyBot")}</p>
      </div>
      <Switch checked={on} disabled={working || state === null} aria-label={t("cloudSync.title")}
        onClick={() => { if (on) setAsking(true); else void perform(() => bridge.set({ enabled: true })); }} />
    </div>
    {asking && <div role="group" className="flex flex-col gap-2 rounded-lg bg-control p-3">
      <span className="text-[13px] text-ink">{t("cloudSync.offTitle")}</span>
      <span className="text-[12px] text-ink-secondary">{t("cloudSync.offHelp")}</span>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-button" data-sync="off-keep" onClick={() => { setAsking(false); void perform(() => bridge.set({ enabled: false, keepCloudCopy: true })); }}>{t("cloudSync.offKeep")}</button>
        <button type="button" className="ui-button" data-sync="off-delete" onClick={() => { setAsking(false); void perform(() => bridge.set({ enabled: false, keepCloudCopy: false })); }}>{t("cloudSync.offDelete")}</button>
        <button type="button" className="ui-button" data-sync="off-cancel" onClick={() => setAsking(false)}>{t("cloudSync.cancel")}</button>
      </div>
    </div>}
    {status && <p role="status" className="text-[13px] text-ink-secondary">{t(status)}</p>}
    {failed && <p role="alert" className="text-[13px] text-danger">{t("cloudSync.failed", { error: failed })}</p>}
    {on && <>
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={state?.openAtLogin === true} disabled={working} onChange={(event) => void perform(() => bridge.set({ openAtLogin: event.target.checked }))} />
        {t("cloudSync.openAtLogin")}
      </label>
      {disk && <div className="flex flex-col gap-1">
        <span className="text-[13px] text-ink">{t("cloudSync.meter", { used: formatSyncBytes(disk.usedBytes), total: formatSyncBytes(disk.planMaxBytes) })}</span>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-control" aria-hidden="true">
          <div className={disk.warn ? "h-full bg-warning" : "h-full bg-accent"} style={{ width: `${Math.min(100, Math.round((disk.usedBytes / disk.planMaxBytes) * 100))}%` }} />
        </div>
        <span className="text-[12px] text-ink-secondary">{t("cloudSync.breakdown", { synced: formatSyncBytes(disk.syncedBytes), bots: formatSyncBytes(disk.botFileBytes), trash: formatSyncBytes(disk.trashBytes) })}</span>
        {disk.warn && <span className="text-[12px] text-warning">{t("cloudSync.almostFull")}</span>}
      </div>}
      {(state?.waiting.length ?? 0) > 0 && <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink">{t("cloudSync.waiting", { count: state!.waiting.length, size: formatSyncBytes(waitingBytes) })}</span>
        <button type="button" className="ui-button" data-sync="upgrade" onClick={() => void bridge.upgrade()}>{t("cloudSync.upgrade")}</button>
      </div>}
      {(state?.missing.length ?? 0) > 0 && <p className="text-[13px] text-ink">{t("cloudSync.missing")}</p>}
      {fileList(t("cloudSync.clashes"), (state?.clashes ?? []).map((item) => ({ folderId: item.folderId, path: item.clashPath, note: item.path })), bridge)}
      {fileList(t("cloudSync.held"), (state?.held ?? []).map((item) => ({ folderId: item.folderId, path: item.path, note: t(item.reason === "windows-name" ? "cloudSync.heldName" : "cloudSync.heldCase") })), bridge, false)}
      {fileList(t("cloudSync.problems"), (state?.problems ?? []).map((item) => ({ folderId: item.folderId, path: item.path, note: item.error })), bridge)}
      {(state?.notices ?? []).map((notice) => <p key={`${notice.folderId}/${notice.path}`} className="text-[12px] text-ink-secondary">{t("cloudSync.notice", { path: notice.path })}</p>)}
      {deleted.length > 0 && <div className="flex flex-col gap-1">
        <span className="text-[13px] text-ink">{t("cloudSync.recentlyDeleted")}</span>
        {deleted.slice(0, 20).map((entry) => <div key={entry.id} className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
          <span className="truncate font-mono">{entry.path}</span>
          <button type="button" className="ui-button" onClick={() => void perform(async () => { const next = await bridge.restore(entry.id); setDeleted(deleted.filter((item) => item.id !== entry.id)); return next; })}>{t("cloudSync.restore")}</button>
        </div>)}
      </div>}
    </>}
  </section>;
}

function fileList(title: string, items: Array<{ folderId: string; path: string; note: string }>, bridge: CloudSyncBridge, showable = true) {
  if (!items.length) return null;
  return <div className="flex flex-col gap-1">
    <span className="text-[13px] text-ink">{title}</span>
    {items.slice(0, 20).map((item) => <div key={`${item.folderId}/${item.path}`} className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
      <span className="truncate"><span className="font-mono">{item.path}</span>: {item.note}</span>
      {showable && item.folderId && <button type="button" className="ui-button" onClick={() => void bridge.open({ folderId: item.folderId, path: item.path })}>{t("cloudSync.show")}</button>}
    </div>)}
  </div>;
}
