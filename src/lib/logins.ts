import type { LoginBots, LoginSummary, OnePasswordStatus } from "../../shared/logins";
import type { ComputerHelpRef } from "../../shared/wire";
import { api } from "@/state/store";

/** What the person typed into a login form. Kept only until it is sent. */
export interface LoginFieldsInput {
  username: string;
  password: string;
  totp: string;
}

export async function listLogins(): Promise<{ logins: LoginSummary[]; onePassword: OnePasswordStatus }> {
  return await api<{ logins: LoginSummary[]; onePassword: OnePasswordStatus }>("/api/logins");
}

/** The server checks the token reaches 1Password before keeping it, and never sends it back. */
export async function connectOnePassword(token: string): Promise<OnePasswordStatus> {
  return (await api<{ onePassword: OnePasswordStatus }>("/api/logins/1password", { method: "POST", body: JSON.stringify({ token }) })).onePassword;
}

export async function refreshOnePassword(): Promise<OnePasswordStatus> {
  return (await api<{ onePassword: OnePasswordStatus }>("/api/logins/1password/refresh", { method: "POST", body: "{}" })).onePassword;
}

export async function disconnectOnePassword(): Promise<OnePasswordStatus> {
  return (await api<{ onePassword: OnePasswordStatus }>("/api/logins/1password", { method: "DELETE" })).onePassword;
}

export async function addLogin(site: string, fields: LoginFieldsInput, bots: LoginBots): Promise<LoginSummary> {
  return (await api<{ login: LoginSummary }>("/api/logins", {
    method: "POST",
    body: JSON.stringify({ site, username: fields.username, password: fields.password, ...(fields.totp.trim() ? { totp: fields.totp } : {}), bots }),
  })).login;
}

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

export async function saveLoginFromCard(ref: Pick<ComputerHelpRef, "botId" | "threadId" | "messageId">, fields: LoginFieldsInput): Promise<void> {
  await api(`/api/bots/${encodeURIComponent(ref.botId)}/sign-in-cards/${encodeURIComponent(ref.messageId)}/save-login`, {
    method: "POST",
    body: JSON.stringify({ threadId: ref.threadId, username: fields.username, password: fields.password, ...(fields.totp.trim() ? { totp: fields.totp } : {}) }),
  });
}
