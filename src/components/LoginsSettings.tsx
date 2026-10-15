import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2, LockKeyhole, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import type { LoginBots, LoginSummary, OnePasswordStatus } from "../../shared/logins";
import { t } from "@/lib/i18n";
import { addLogin, changeLogin, connectOnePassword, deleteLogin, disconnectOnePassword, listLogins, refreshOnePassword } from "@/lib/logins";
import { relativeTime } from "@/lib/memory";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore } from "@/state/store";
import { LoginBotPicker, LoginForm } from "./LoginForm";
import { Card } from "./SettingsPrimitives";

// Security: a row never shows the password, which no route returns.

const SOURCE_KEYS = {
  card: "settings.logins.source.card",
  settings: "settings.logins.source.settings",
  "1password": "settings.logins.source.1password",
} as const;

const ROW_BUTTON = "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

export function LoginsSettings() {
  const { state } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const bots = state.bots.map((bot) => ({ id: bot.id, name: bot.name }));
  const [logins, setLogins] = useState<LoginSummary[] | null>(null);
  const [onePassword, setOnePassword] = useState<OnePasswordStatus>({ connected: false });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [site, setSite] = useState("");
  const [addBots, setAddBots] = useState<LoginBots>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [editBots, setEditBots] = useState<LoginBots>("all");
  const [removeTotp, setRemoveTotp] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const answer = await listLogins();
      setLogins(answer.logins);
      setOnePassword(answer.onePassword ?? { connected: false });
      setError(null);
    }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.loadError")); }
  };
  useEffect(() => { if (ownerOrAdmin) void load(); }, [ownerOrAdmin]);

  if (ownerOrAdmin === false) {
    return <Card title={t("settings.logins.title")} subtitle={t("settings.logins.adminOnly")} />;
  }

  const botNames = (value: LoginBots) => {
    if (value === "all") return t("settings.logins.allBots");
    const names = value.flatMap((id) => bots.find((bot) => bot.id === id)?.name ?? []);
    return names.length ? names.join(", ") : t("settings.logins.noBots");
  };
  const startEdit = (login: LoginSummary) => {
    setAdding(false);
    setDeleting(null);
    setRemoveTotp(false);
    setEditBots(login.bots);
    setEditing(login.id);
  };
  const remove = async (id: string) => {
    if (deleting !== id) { setDeleting(id); return; }
    setBusy(true);
    try { await deleteLogin(id); setDeleting(null); await load(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.deleteError")); }
    finally { setBusy(false); }
  };

  return (
    <Card title={t("settings.logins.title")} subtitle={t("settings.logins.subtitle")}>
      <div className="flex flex-col gap-3" aria-busy={logins === null || busy}>
        {logins === null && !error && <p className="text-[12px] text-ink-secondary">{t("settings.logins.loading")}</p>}
        {logins?.length === 0 && !adding && <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.logins.empty")}</p>}
        {!!logins?.length && (
          <ul className="divide-y divide-hairline/30" data-logins-list>
            {logins.map((login) => (
              <li key={login.id} className="flex flex-col gap-2 py-2.5" data-login-row={login.host}>
                <div className="flex min-w-0 items-start gap-2">
                  <KeyRound size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-ink-tertiary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span dir="ltr" className="truncate text-[13px] font-medium text-ink" title={login.host}>{login.host}</span>
                      {login.hasTotp && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-ink/[0.07] px-1.5 text-[11px] text-ink-secondary">
                          <ShieldCheck size={11} aria-hidden="true" />{t("settings.logins.twoFactor")}
                        </span>
                      )}
                    </div>
                    <div dir="auto" className="truncate text-[12px] text-ink-secondary">{login.username || t("settings.logins.noUsername")}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-ink-tertiary">
                      {[t(SOURCE_KEYS[login.source]), botNames(login.bots),
                        login.lastUsedAt ? t("settings.logins.used", { when: relativeTime(login.lastUsedAt) }) : t("settings.logins.neverUsed")].join(" · ")}
                    </div>
                  </div>
                  {login.source !== "1password" && (
                    <div className="flex shrink-0 gap-1">
                      <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => startEdit(login)}
                        aria-label={t("settings.logins.changeFor", { site: login.host })}>{t("settings.logins.change")}</button>
                      <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => void remove(login.id)}
                        aria-label={deleting === login.id ? t("settings.logins.deleteConfirm") : t("settings.logins.deleteFor", { site: login.host })}>
                        <Trash2 size={13} />{deleting === login.id ? t("settings.logins.deleteConfirm") : t("settings.logins.delete")}
                      </button>
                    </div>
                  )}
                </div>
                {editing === login.id && (
                  <div className="ms-6 rounded-lg bg-inset/60 p-3">
                    <LoginForm username={false} replacing submitLabel={t("settings.logins.saveChange")} autoFocus
                      onCancel={() => setEditing(null)}
                      onSubmit={async (fields) => {
                        await changeLogin(login.id, { password: fields.password, totp: fields.totp, removeTotp, bots: editBots });
                        setEditing(null);
                        await load();
                      }}>
                      {login.hasTotp && (
                        <label className="flex items-center gap-2 text-[12.5px] text-ink">
                          <input type="checkbox" checked={removeTotp} onChange={(event) => setRemoveTotp(event.target.checked)} />
                          {t("settings.logins.removeTotp")}
                        </label>
                      )}
                      <LoginBotPicker value={editBots} onChange={setEditBots} bots={bots} />
                    </LoginForm>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <div className="rounded-lg bg-inset/60 p-3">
            <LoginForm site={{ value: site, onChange: setSite }} submitLabel={t("settings.logins.save")} autoFocus
              onCancel={() => setAdding(false)}
              onSubmit={async (fields) => {
                await addLogin(site, fields, addBots);
                setAdding(false);
                setSite("");
                setAddBots("all");
                await load();
              }}>
              <LoginBotPicker value={addBots} onChange={setAddBots} bots={bots} />
            </LoginForm>
          </div>
        ) : (
          <button type="button" className="ui-button ui-button-md self-start" disabled={logins === null}
            onClick={() => { setEditing(null); setDeleting(null); setAdding(true); }}>
            <Plus size={14} />{t("settings.logins.add")}
          </button>
        )}
        <p className="text-[11.5px] leading-relaxed text-ink-tertiary">{t("settings.logins.limits")}</p>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        <OnePasswordConnection status={onePassword} disabled={logins === null}
          onChange={async (next) => { setOnePassword(next); await load(); }} />
      </div>
    </Card>
  );
}

function OnePasswordConnection({ status, disabled, onChange }: {
  status: OnePasswordStatus;
  disabled: boolean;
  onChange: (status: OnePasswordStatus) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<OnePasswordStatus>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try { await onChange(await work()); if (kind === "connect") setToken(""); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.onePassword.error")); }
    finally { setBusy(null); }
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) void run("connect", () => connectOnePassword(token.trim()));
  };
  return (
    <section className="mt-1 flex flex-col gap-2 border-t border-hairline/30 pt-3" aria-label={t("settings.logins.onePassword.title")} data-onepassword>
      <div className="text-[13px] font-medium text-ink">{t("settings.logins.onePassword.title")}</div>
      {status.connected ? (
        <>
          <p className="text-[12.5px] leading-snug text-ink-secondary">
            {t("settings.logins.onePassword.connected", { vaults: (status.vaults ?? []).join(", ") || "—", count: String(status.items ?? 0) })}
          </p>
          {status.error && <p role="alert" className="text-[12px] text-danger">{status.error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-button ui-button-md" disabled={disabled || busy !== null} onClick={() => void run("refresh", refreshOnePassword)}>
              {busy === "refresh" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}{t("settings.logins.onePassword.refresh")}
            </button>
            <button type="button" className="ui-button ui-button-md" disabled={disabled || busy !== null} onClick={() => void run("disconnect", disconnectOnePassword)}>
              {t("settings.logins.onePassword.disconnect")}
            </button>
          </div>
        </>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={connect}>
          <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.logins.onePassword.guide")}</p>
          <div className="flex flex-wrap gap-2">
            <input name="onePasswordToken" type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={token}
              onChange={(event) => setToken(event.target.value)} disabled={disabled || busy !== null}
              aria-label={t("settings.logins.onePassword.token")} placeholder={t("settings.logins.onePassword.token")}
              className="min-w-0 flex-1 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60" />
            <button type="submit" className="ui-button ui-button-md ui-button-primary" disabled={disabled || busy !== null || !token.trim()}>
              {busy === "connect" && <Loader2 size={13} className="animate-spin" />}{t("settings.logins.onePassword.connect")}
            </button>
          </div>
        </form>
      )}
      <p className="flex items-start gap-1 text-[11.5px] leading-snug text-ink-tertiary">
        <LockKeyhole size={11} aria-hidden="true" className="mt-[3px] shrink-0" /> {t("settings.logins.onePassword.note")}
      </p>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </section>
  );
}
