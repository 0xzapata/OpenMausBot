// 1Password as a second source of logins for fill_login (Settings → Logins →
// Connect 1Password). The person pastes a service account token, which
// 1Password itself limits to the vaults it was given (one, such as "Shared
// with OMB"); the token is kept in the sealed login store
// (server/login-store.ts), never in config.json or a log.
//
// Not a parallel system: a 1Password Login item with a website is one more
// candidate in the same fill path (server/login-fill.ts) — the same exact
// host rule, the same RFC 6238 code from its one-time-password field, the
// same scrubbing. Its rows in Settings are read-only; it is changed in
// 1Password. Only hosts, usernames and whether a 2FA field exists are kept
// here; a password is read from 1Password when that login is filled.
//
// The official SDK (@1password/sdk, MIT) is a CommonJS wrapper over a 14 MB
// WebAssembly core it reads from beside itself, so it is never bundled: it is
// required on first use from the same staged tree as DuckDB
// (scripts/prepare-duckdb.mjs), and only when a token exists.
import type { LoginSummary, OnePasswordStatus } from "../shared/logins.ts";
import { normalizeLoginHost } from "../shared/logins.ts";
import type { FillCandidate } from "./login-fill.ts";
import { parseTotpKey } from "./totp.ts";

/** A Login item's fields, read when it is filled. */
export interface OnePasswordItemFields {
  username: string;
  password: string;
  /** The one-time-password field: an otpauth:// address or a bare secret. */
  totp: string | null;
}

/** The slice of 1Password used here. The SDK adapter below makes one; tests
 * pass a fake. */
export interface OnePasswordClient {
  vaults(): Promise<Array<{ id: string; title: string }>>;
  /** Login items with at least one website. */
  loginItems(vaultId: string): Promise<Array<{ id: string; title: string; urls: string[] }>>;
  fields(vaultId: string, itemIds: string[]): Promise<Map<string, OnePasswordItemFields>>;
}

// ── the SDK adapter ────────────────────────────────────────────────────

interface SdkField { id: string; title: string; fieldType: string; value: string }
interface SdkClient {
  vaults: { list(): Promise<Array<{ id: string; title: string }>> };
  items: {
    list(vaultId: string): Promise<Array<{ id: string; title: string; category: string; websites?: Array<{ url: string }> }>>;
    getAll(vaultId: string, itemIds: string[]): Promise<{ individualResponses: Array<{ content?: { id: string; fields: SdkField[] }; error?: unknown }> }>;
  };
}
/** What `@1password/sdk` exports that is used here. */
export interface OnePasswordSdk {
  createClient(config: { auth: string; integrationName: string; integrationVersion: string }): Promise<SdkClient>;
}

/** The Login item's username, password and one-time-password fields, by
 * their built-in ids first, then by type and title. */
export function loginFields(fields: readonly SdkField[]): OnePasswordItemFields {
  const byId = (id: string) => fields.find((field) => field.id === id && field.value);
  const username = byId("username")
    ?? fields.find((field) => (field.fieldType === "Text" || field.fieldType === "Email") && /user|e-?mail|login/iu.test(field.title) && field.value);
  const password = byId("password") ?? fields.find((field) => field.fieldType === "Concealed" && /pass/iu.test(field.title) && field.value);
  const totp = fields.find((field) => field.fieldType === "Totp" && field.value);
  return { username: username?.value ?? "", password: password?.value ?? "", totp: totp?.value ?? null };
}

/** A client over the official SDK, signed in with a service account token. */
export async function sdkOnePasswordClient(sdk: OnePasswordSdk, token: string, version: string): Promise<OnePasswordClient> {
  const client = await sdk.createClient({ auth: token, integrationName: "OpenMausBot", integrationVersion: version });
  return {
    vaults: async () => (await client.vaults.list()).map((vault) => ({ id: vault.id, title: vault.title })),
    loginItems: async (vaultId) => (await client.items.list(vaultId))
      .filter((item) => item.category === "Login" && (item.websites?.length ?? 0) > 0)
      .map((item) => ({ id: item.id, title: item.title, urls: (item.websites ?? []).map((site) => site.url) })),
    fields: async (vaultId, itemIds) => {
      const found = new Map<string, OnePasswordItemFields>();
      if (!itemIds.length) return found;
      const { individualResponses } = await client.items.getAll(vaultId, itemIds);
      for (const response of individualResponses) if (response.content) found.set(response.content.id, loginFields(response.content.fields));
      return found;
    },
  };
}

// ── the cached index ───────────────────────────────────────────────────

/** One 1Password login on one host: an item with two websites is two. */
interface Entry {
  id: string;
  vaultId: string;
  itemId: string;
  host: string;
  username: string;
  hasTotp: boolean;
}

const ID_PREFIX = "1password:";
/** Items read per vault, at most. A service account meant for bots holds a
 * handful; this bounds a token given a whole company's vault. */
const MAX_ITEMS = 500;
const FIELDS_BATCH = 50;
/** How old the index may get before a fill or the Settings list reads it again. */
const STALE_MS = 10 * 60_000;

export function isOnePasswordLoginId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

/** What went wrong, in words for the person, never the token. */
export function onePasswordProblem(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const text = error instanceof Error ? error.message : String(error);
  if (name === "RateLimitExceededError" || /rate limit/iu.test(text)) return "1Password is limiting requests right now. Try again in a few minutes.";
  if (name === "AuthExpiredError" || /invalid|unauthori[sz]ed|authenticat|token|forbidden|401|403/iu.test(text)) {
    return "1Password did not accept the token. Paste a service account token (it starts with ops_), or make a new one.";
  }
  if (/fetch|network|ENOTFOUND|ECONN|timed? ?out|dns/iu.test(text)) return "Could not reach 1Password. Check the internet connection and try again.";
  return "1Password could not be read. Try again, or connect it again with a new token.";
}

export class OnePasswordLogins {
  private readonly token: () => string | null;
  private readonly connect: (token: string) => Promise<OnePasswordClient>;
  private readonly now: () => number;
  private client: { token: string; client: OnePasswordClient } | null = null;
  private entries: Entry[] = [];
  private vaults: string[] = [];
  private items = 0;
  /** When the index was last read; null for never. */
  private refreshedAt: number | null = null;
  private error: string | undefined;
  private refreshing: Promise<OnePasswordStatus> | null = null;
  private readonly lastUsed = new Map<string, number>();

  constructor(options: { token: () => string | null; connect: (token: string) => Promise<OnePasswordClient>; now?: () => number }) {
    this.token = options.token;
    this.connect = options.connect;
    this.now = options.now ?? Date.now;
  }

  status(): OnePasswordStatus {
    if (!this.token()) return { connected: false };
    return { connected: true, vaults: [...this.vaults], items: this.items, ...(this.error ? { error: this.error } : {}) };
  }

  private async clientFor(token: string): Promise<OnePasswordClient> {
    if (this.client?.token === token) return this.client.client;
    const client = await this.connect(token);
    this.client = { token, client };
    return client;
  }

  /** Read the vaults the token reaches: every Login item with a website, by
   * host, with its username and whether it has a one-time-password field.
   * `token`: try this one instead of the saved one (Connect checks a token
   * before keeping it); it throws instead of noting the problem. */
  refresh(token?: string): Promise<OnePasswordStatus> {
    if (!token && this.refreshing) return this.refreshing;
    const run = this.read(token).finally(() => { if (this.refreshing === run) this.refreshing = null; });
    if (!token) this.refreshing = run;
    return run;
  }

  private async read(candidate?: string): Promise<OnePasswordStatus> {
    const token = candidate ?? this.token();
    if (!token) { this.clear(); return this.status(); }
    try {
      const client = await this.clientFor(token);
      const vaults = await client.vaults();
      const entries: Entry[] = [];
      let items = 0;
      for (const vault of vaults) {
        const logins = (await client.loginItems(vault.id)).slice(0, MAX_ITEMS);
        for (let start = 0; start < logins.length; start += FIELDS_BATCH) {
          const batch = logins.slice(start, start + FIELDS_BATCH);
          // Read for the username and whether a 2FA field exists; the
          // password in this answer is dropped here and read again at fill.
          const fields = await client.fields(vault.id, batch.map((item) => item.id));
          for (const item of batch) {
            const found = fields.get(item.id);
            if (!found?.password) continue;
            items++;
            const hosts = new Set(item.urls.flatMap((url) => normalizeLoginHost(url) ?? []));
            for (const host of hosts) {
              entries.push({ id: `${ID_PREFIX}${vault.id}:${item.id}:${host}`, vaultId: vault.id, itemId: item.id, host,
                username: found.username, hasTotp: Boolean(found.totp && parseTotpKey(found.totp)) });
            }
          }
        }
      }
      this.entries = entries.sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
      this.vaults = vaults.map((vault) => vault.title).sort((a, b) => a.localeCompare(b));
      this.items = items;
      this.refreshedAt = this.now();
      this.error = undefined;
      return { connected: true, vaults: [...this.vaults], items };
    } catch (error) {
      this.client = null;
      if (candidate) throw new Error(onePasswordProblem(error));
      this.error = onePasswordProblem(error);
      return this.status();
    }
  }

  /** Forget everything read from 1Password (Disconnect). */
  clear(): void {
    this.client = null;
    this.entries = [];
    this.vaults = [];
    this.items = 0;
    this.refreshedAt = null;
    this.error = undefined;
    this.lastUsed.clear();
  }

  /** Read again when the index is older than a few minutes; never throws. */
  async fresh(): Promise<void> {
    if (!this.token()) return;
    if (this.refreshedAt === null || this.now() - this.refreshedAt > STALE_MS) await this.refresh();
  }

  /** Settings rows: read-only, usable by every bot (1Password scopes the vault). */
  list(): LoginSummary[] {
    if (!this.token()) return [];
    return this.entries.map((entry) => ({
      id: entry.id, host: entry.host, username: entry.username, hasTotp: entry.hasTotp, source: "1password",
      bots: "all", createdAt: 0, ...(this.lastUsed.has(entry.itemId) ? { lastUsedAt: this.lastUsed.get(entry.itemId)! } : {}),
    }));
  }

  hosts(): Array<{ host: string; username: string }> {
    return this.token() ? this.entries.map((entry) => ({ host: entry.host, username: entry.username })) : [];
  }

  /** The 1Password logins for exactly this host, as fill candidates. The
   * password and the one-time-password key are read when one is filled. */
  candidates(host: string): FillCandidate[] {
    const token = this.token();
    if (!token) return [];
    return this.entries.filter((entry) => entry.host === host).map((entry) => ({
      id: entry.id, host: entry.host, username: entry.username, source: "1password" as const,
      secrets: async () => {
        let found: OnePasswordItemFields | undefined;
        try {
          const client = await this.clientFor(token);
          found = (await client.fields(entry.vaultId, [entry.itemId])).get(entry.itemId);
        } catch (error) {
          this.client = null;
          throw new Error(onePasswordProblem(error));
        }
        if (!found?.password) throw new Error("This login is no longer in 1Password, or has no password there.");
        return { password: found.password, totp: found.totp ? parseTotpKey(found.totp) : null };
      },
    }));
  }

  markUsed(id: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) this.lastUsed.set(entry.itemId, this.now());
  }
}
