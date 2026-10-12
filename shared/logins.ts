/**
 * Saved logins: a website username and password (and optionally its 2FA key)
 * the person keeps in OpenMausBot so a bot can sign in without them. The bot
 * never receives the password: it calls fill_login on the login page and the
 * server fills the fields itself (server/login-fill.ts). This is the shape
 * every client sees — a saved login as a list row, never its secrets — and
 * the address rules the server and the forms share.
 */

/** Where a login came from: the sign-in card's Save, Settings → Logins, or
 * the person's 1Password vault (read-only here). */
export type LoginSource = "card" | "settings" | "1password";

/** Which bots may use a login: every bot, or the ones named. */
export type LoginBots = "all" | string[];

/** One saved login as Settings shows it. There is no password field, and no
 * route ever returns one: a saved password is only ever replaced. */
export interface LoginSummary {
  id: string;
  /** The exact host of the login page, such as accounts.example.com. */
  host: string;
  username: string;
  /** A 2FA setup key is saved, so the one-time code is filled too. */
  hasTotp: boolean;
  source: LoginSource;
  bots: LoginBots;
  createdAt: number;
  lastUsedAt?: number;
}

/** 1Password, connected with a service account (Settings → Logins). The
 * token itself never leaves the server. */
export interface OnePasswordStatus {
  connected: boolean;
  /** The vaults the service account can read, by name. */
  vaults?: string[];
  /** How many of its items have a website and a password. */
  items?: number;
  error?: string;
}

/** The longest username or password a form takes. */
export const LOGIN_FIELD_MAX = 512;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

/** A login's host from what the person typed: a page address or a bare
 * domain. The host is kept exactly (accounts.example.com stays itself, and
 * www. is not dropped), because a login is filled only on that exact host.
 * Anything that is not a plain http(s) address is refused. */
export function normalizeLoginHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters and spaces before URL parsing normalizes them.
  if (!text || text.length > 2048 || /[\u0000- \u007f\\]/u.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") && host !== "localhost" && !host.startsWith("[")) return null;
  return host;
}

/** Whether a login for `host` may be filled on the page at `pageUrl`: the
 * page is https (or plain http on this computer, for a developer's own app)
 * and its host is exactly the login's — not a subdomain, not the parent.
 * A reason in words when not. */
export function loginOriginCheck(pageUrl: string, host: string): { ok: true; pageHost: string } | { ok: false; pageHost: string | null; reason: "address" | "insecure" | "host" } {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return { ok: false, pageHost: null, reason: "address" }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, pageHost: null, reason: "address" };
  const pageHost = url.hostname.toLowerCase();
  if (url.protocol === "http:" && !isLoopbackHost(pageHost)) return { ok: false, pageHost, reason: "insecure" };
  if (pageHost !== host.toLowerCase()) return { ok: false, pageHost, reason: "host" };
  return { ok: true, pageHost };
}

/** Whether a bot may use a login. */
export function loginUsableBy(login: { bots: LoginBots }, botId: string): boolean {
  return login.bots === "all" || login.bots.includes(botId);
}

/** The resume line after the person saved a login from a sign-in card. */
export function savedLoginResumePrompt(host: string): string {
  return `OpenMausBot sign-in update: the person saved a login for ${host}. Open its login page in your browser and call fill_login there, then submit the form and check you are signed in. You never see the password. Never ask for a password or a one-time code in chat.`;
}
