import type { LoginBots, LoginSummary } from "../../shared/logins";
import type { ComputerHelpRef } from "../../shared/wire";
import { api } from "@/state/store";

/** What the person typed into a login form. Kept only until it is sent. */
export interface LoginFieldsInput {
  username: string;
  password: string;
  /** A 2FA setup key or otpauth:// address; empty for none. */
  totp: string;
}

export async function listLogins(): Promise<LoginSummary[]> {
  return (await api<{ logins: LoginSummary[] }>("/api/logins")).logins;
}

export async function addLogin(site: string, fields: LoginFieldsInput, bots: LoginBots): Promise<LoginSummary> {
  return (await api<{ login: LoginSummary }>("/api/logins", {
    method: "POST",
    body: JSON.stringify({ site, username: fields.username, password: fields.password, ...(fields.totp.trim() ? { totp: fields.totp } : {}), bots }),
  })).login;
}

/** Replace a login's password or 2FA key, or change who may use it. An
 * empty password or key leaves the saved one; `removeTotp` drops the key. */
export async function changeLogin(id: string, change: { password?: string; totp?: string; removeTotp?: boolean; bots?: LoginBots }): Promise<LoginSummary> {
  return (await api<{ login: LoginSummary }>(`/api/logins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(change.password ? { password: change.password } : {}),
      ...(change.removeTotp ? { totp: null } : change.totp?.trim() ? { totp: change.totp } : {}),
      ...(change.bots ? { bots: change.bots } : {}),
    }),
  })).login;
}

export async function deleteLogin(id: string): Promise<void> {
  await api(`/api/logins/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The sign-in card's Save: the login is kept for the card's page, usable by
 * the asking bot, and the bot resumes to fill it (server/index.ts
 * saveLoginFromCard). */
export async function saveLoginFromCard(ref: Pick<ComputerHelpRef, "botId" | "threadId" | "messageId">, fields: LoginFieldsInput): Promise<void> {
  await api(`/api/bots/${encodeURIComponent(ref.botId)}/sign-in-cards/${encodeURIComponent(ref.messageId)}/save-login`, {
    method: "POST",
    body: JSON.stringify({ threadId: ref.threadId, username: fields.username, password: fields.password, ...(fields.totp.trim() ? { totp: fields.totp } : {}) }),
  });
}
