// fill_login: the server signs a bot in with a saved login, on the page the
// bot has open, without the bot ever holding the password.
//
// Everything happens in the bot's own running browser through the engine,
// the same way in the built-in browser and in My Chrome (a profile attached
// to the person's Chrome), and nothing here ever launches a browser:
//   1. `get url` names the bot's current page. It must be https (plain http
//      only on this computer) and its host exactly the login's.
//   2. An in-page script finds the visible login fields and marks them. It
//      carries no secret, and its answer is booleans, never field values.
//   3. Each field is focused (and emptied the way a person would, so
//      React-style forms see the change), the page's address is checked
//      again, and the value goes in as real typing: the engine's input relay
//      (`keyboard insertText`, the call the Browser tab's masked "Type a
//      password or code" box makes) over its loopback relay
//      (browser-relay.ts), never on a command line.
//   4. A last script reports which fields hold text and removes the marks.
// Two-step logins fill what is visible (the username, then the password on
// the next page), and a one-time-code field gets a TOTP code made at fill
// time. The bot hears what was filled, or why not — never a value.
import { randomBytes } from "node:crypto";

import { loginOriginCheck, type LoginSource } from "../shared/logins.ts";
import { totpCode, type TotpKey } from "./totp.ts";

/** One login the bot may use on a host, from any source. Its secrets are
 * read only when it is about to be filled. */
export interface FillCandidate {
  id: string;
  host: string;
  username: string;
  source: LoginSource;
  secrets(): Promise<{ password: string; totp: TotpKey | null }>;
}

export interface FillLoginDeps {
  /** One engine command in the bot's running browser: its answer's data, or
   * null when that browser is not running. */
  engine(args: string[]): Promise<Record<string, unknown> | null>;
  /** Type text into the page's focused field, as real input. */
  insertText(text: string): Promise<void>;
  /** Every secret value about to reach the page, so the scrubber knows it. */
  remember(value: string, kind: "password" | "code"): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FillLoginInput {
  username?: string;
  /** The logins this bot may use on a host, and every host it has one for
   * (named in a refusal so the bot knows where it can sign in). */
  candidates(host: string): Promise<FillCandidate[]>;
  available(): Promise<Array<{ host: string; username: string }>>;
}

export type FilledField = "username" | "password" | "code";

export interface FillLoginOutcome {
  ok: boolean;
  /** What the bot is told. Never a value. */
  text: string;
  host?: string;
  loginId?: string;
  filled?: FilledField[];
}

const MARK = "data-omb-login";

/** In-page: find the visible login fields, mark them, and say which exist.
 * Plain JS in a string: what the page runs is exactly what is written here. */
const FIND_FIELDS = `((nonce) => {
  const MARK = ${JSON.stringify(MARK)};
  for (const old of document.querySelectorAll("[" + MARK + "]")) old.removeAttribute(MARK);
  const shown = (el) => {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly || el.type === "hidden") return false;
    if (el.getClientRects().length === 0) return false;
    for (let node = el; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
    }
    return true;
  };
  const tokens = (el) => (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
  const hint = (el) => [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.getAttribute("autocomplete")].join(" ").toLowerCase();
  const plain = (el) => el.type === "text" || el.type === "email" || el.type === "tel";
  // A strong hint makes even a password-type box a code box; a weak one
  // ("verify", "code") only a plain one, so a sign-up form's "verify
  // password" box is never taken for a code.
  const STRONG = /(?:^|[^a-z])t?otp|2fa|mfa|two[-_ ]?factor|one[-_ ]?time/;
  const WEAK = /verif|security[-_ ]?code|auth\\w*[-_ ]?code|passcode|\\bcode\\b/;
  const NOT_CODE = /zip|postal|promo|coupon|country|area|invite|referr/;
  const isCode = (el) => tokens(el).includes("one-time-code") ||
    ((plain(el) || el.type === "number" || el.type === "password") && STRONG.test(hint(el)) && !NOT_CODE.test(hint(el))) ||
    ((plain(el) || el.type === "number") && WEAK.test(hint(el)) && !NOT_CODE.test(hint(el)));
  const inputs = Array.from(document.querySelectorAll("input")).filter(shown);
  const codes = inputs.filter(isCode);
  const rest = inputs.filter((el) => !codes.includes(el));
  const passwords = rest.filter((el) => el.type === "password" && !tokens(el).includes("new-password"));
  const password = passwords.find((el) => tokens(el).includes("current-password")) || passwords[0] || null;
  const USER = /user|e-?mail|login|account|identifier|phone|mobile/;
  const userLike = (el) => tokens(el).includes("username") || tokens(el).includes("email") || el.type === "email" || (plain(el) && USER.test(hint(el)));
  let username = null;
  if (password) {
    const scope = rest.filter((el) => el !== password && plain(el) && (password.form ? el.form === password.form : !el.form));
    const before = scope.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    username = before.filter(userLike).pop() || before.pop() || scope.find(userLike) || null;
  } else {
    username = rest.find((el) => tokens(el).includes("username")) || rest.find((el) => plain(el) && userLike(el)) || null;
  }
  let boxes = [];
  if (codes.length) {
    const first = codes[0];
    const near = (el) => el.parentElement === first.parentElement || (el.parentElement && first.parentElement && el.parentElement.parentElement === first.parentElement.parentElement);
    const group = first.maxLength === 1 ? inputs.filter((el) => el.maxLength === 1 && near(el)) : [];
    boxes = group.length >= 4 ? group : [first];
  }
  if (username) username.setAttribute(MARK, nonce + ":username");
  if (password) password.setAttribute(MARK, nonce + ":password");
  boxes.forEach((el, index) => el.setAttribute(MARK, nonce + ":code" + index));
  return JSON.stringify({ href: location.href, username: Boolean(username), password: Boolean(password), code: boxes.length });
})`;

/** In-page: focus one marked field and empty it the way typing over it
 * would, so a React-style form's state follows. `same`: the field already
 * holds this text (a username, never a secret), so it is left alone. */
const FOCUS_FIELD = `((nonce, name, keep) => {
  const el = document.querySelector("[${MARK}=\\"" + nonce + ":" + name + "\\"]");
  if (!(el instanceof HTMLInputElement)) return JSON.stringify({ href: location.href, focused: false, same: false });
  if (typeof keep === "string" && el.value === keep) return JSON.stringify({ href: location.href, focused: true, same: true });
  try { el.scrollIntoView({ block: "center" }); } catch {}
  el.focus();
  if (el.value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return JSON.stringify({ href: location.href, focused: document.activeElement === el, same: false });
})`;

/** In-page: which marked fields hold text now (booleans only), and remove
 * every mark. */
const CHECK_FIELDS = `((nonce) => {
  const out = {};
  for (const el of document.querySelectorAll("[${MARK}]")) {
    const [owner, name] = (el.getAttribute("${MARK}") || "").split(":");
    if (owner === nonce) out[name] = typeof el.value === "string" && el.value.length > 0;
    el.removeAttribute("${MARK}");
  }
  return JSON.stringify(out);
})`;

function call(script: string, ...args: unknown[]): string {
  return `${script}(${args.map((arg) => JSON.stringify(arg ?? null)).join(", ")})`;
}

/** An eval answer as a value: agent-browser hands back the expression's
 * result, which these scripts make a JSON string. */
function evaluated(data: Record<string, unknown> | null): Record<string, unknown> | null {
  let value: unknown = data?.result;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function listed(logins: Array<{ host: string; username: string }>): string {
  if (!logins.length) return "You have no saved logins.";
  const shown = logins.slice(0, 12).map((login) => `${login.host} (${login.username})`);
  return `Your saved logins: ${shown.join(", ")}${logins.length > shown.length ? ` and ${logins.length - shown.length} more` : ""}.`;
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

const FIELD_WORDS: Record<FilledField, string> = { username: "the username", password: "the password", code: "the one-time code" };

export async function fillLogin(input: FillLoginInput, deps: FillLoginDeps): Promise<FillLoginOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const page = await deps.engine(["get", "url"]);
  const pageUrl = typeof page?.url === "string" ? page.url : "";
  if (!page || !pageUrl || pageUrl === "about:blank") {
    return { ok: false, text: "The browser has no page open. Open the site's login page first, then call fill_login." };
  }
  // The page must be one a login may ever be filled on before any login is
  // looked at; the exact host is matched below.
  let pageHost = "";
  try { pageHost = new URL(pageUrl).hostname.toLowerCase(); } catch { /* refused just below */ }
  const origin = loginOriginCheck(pageUrl, pageHost);
  if (!origin.ok) {
    return { ok: false, host: pageHost || undefined, text: origin.reason === "insecure"
      ? `This page (${pageHost}) is not secure (http, not https). fill_login only fills https pages, or http on this computer.`
      : "The current page is not a web page fill_login can fill. Open the site's login page, then call fill_login." };
  }
  const all = await input.candidates(pageHost);
  if (!all.length) {
    return { ok: false, host: pageHost, text: `No saved login for ${pageHost}. A login is filled only on the exact host it was saved for, never on a subdomain or another site. ${listed(await input.available())} Open that site's login page, or call request_sign_in so the person signs in.` };
  }
  let chosen = all;
  const wanted = input.username?.trim();
  if (wanted) {
    chosen = all.filter((login) => login.username.toLowerCase() === wanted.toLowerCase());
    if (!chosen.length) {
      return { ok: false, host: pageHost, text: `No saved login for ${pageHost} has the username ${JSON.stringify(wanted)}. The usernames saved there: ${all.map((login) => login.username).join(", ")}.` };
    }
  }
  if (chosen.length > 1) {
    return { ok: false, host: pageHost, text: `There are ${chosen.length} saved logins for ${pageHost}: ${chosen.map((login) => login.username).join(", ")}. Call fill_login again with the username to use.` };
  }
  const login = chosen[0]!;
  // Re-checked against the login's own host (equal by construction) so the
  // rule stays in one place.
  if (!loginOriginCheck(pageUrl, login.host).ok) {
    return { ok: false, host: pageHost, text: `This page's host (${pageHost}) does not match the saved login's host (${login.host}).` };
  }

  const nonce = randomBytes(12).toString("hex");
  const found = evaluated(await deps.engine(["eval", call(FIND_FIELDS, nonce)]));
  if (!found) return { ok: false, host: pageHost, text: "The browser closed or did not answer. Open the login page again, then call fill_login." };
  const stillHere = (href: unknown) => typeof href === "string" && loginOriginCheck(href, login.host).ok;
  if (!stillHere(found.href)) return { ok: false, host: pageHost, text: `The page moved away from ${login.host} before anything was filled. Open its login page again, then call fill_login.` };
  const codeBoxes = typeof found.code === "number" ? Math.min(Math.max(0, found.code), 12) : 0;
  if (found.username !== true && found.password !== true && codeBoxes === 0) {
    await deps.engine(["eval", call(CHECK_FIELDS, nonce)]).catch(() => null);
    return { ok: false, host: pageHost, loginId: login.id, text: `No login fields found on ${pageHost}. Open its sign-in page (the one with the username, password or code box), then call fill_login again.` };
  }

  const secrets = await login.secrets();
  let filled: FilledField[] = [];
  let moved = false;
  const fill = async (name: string, text: string, keep?: string): Promise<boolean> => {
    const focus = evaluated(await deps.engine(["eval", call(FOCUS_FIELD, nonce, name, keep ?? null)]));
    if (!focus || !stillHere(focus.href)) { moved = true; return false; }
    if (focus.same === true) return true;
    if (focus.focused !== true) return false;
    await deps.insertText(text);
    return true;
  };
  try {
    if (found.username === true && login.username) {
      if (await fill("username", login.username, login.username)) filled.push("username");
    }
    deps.remember(secrets.password, "password");
    if (secrets.totp) deps.remember(secrets.totp.secret, "password");
    if (!moved && found.password === true) {
      if (await fill("password", secrets.password)) filled.push("password");
    }
    if (!moved && codeBoxes > 0 && secrets.totp) {
      // A code about to expire is not worth typing: wait for the next one.
      const left = secrets.totp.period * 1000 - (now() % (secrets.totp.period * 1000));
      if (left < 3_000) await sleep(left + 250);
      const code = totpCode(secrets.totp, now());
      deps.remember(code, "code");
      let typed = 0;
      if (codeBoxes === 1) typed = (await fill("code0", code)) ? 1 : 0;
      else for (let index = 0; index < codeBoxes && index < code.length && !moved; index++) if (await fill(`code${index}`, code[index]!)) typed++;
      if (typed > 0) filled.push("code");
    }
  } finally {
    const checked = evaluated(await deps.engine(["eval", call(CHECK_FIELDS, nonce)]).catch(() => null));
    // Only fields that hold text count as filled.
    if (checked) filled = filled.filter((field) => field === "code" ? checked.code0 === true : checked[field] === true);
  }
  if (moved && !filled.length) {
    return { ok: false, host: pageHost, loginId: login.id, text: `The page moved away from ${login.host} before anything was filled. Open its login page again, then call fill_login.` };
  }
  const codeMissing = codeBoxes > 0 && !secrets.totp;
  if (!filled.length) {
    return { ok: false, host: pageHost, loginId: login.id, text: codeMissing
      ? `This page on ${pageHost} asks for a one-time code, and the saved login has no 2FA key. Call request_sign_in so the person can enter the code.`
      : `Could not fill the login fields on ${pageHost}: the page did not take the typing. Click the field once, then call fill_login again, or call request_sign_in.` };
  }
  const next = filled.includes("password") || filled.includes("code")
    ? " Submit the form now (its sign-in button, or Enter), then check you are signed in."
    : " Go on to the next step (such as Next or Continue), then call fill_login again for the password.";
  const note = codeMissing ? " The page also asks for a one-time code, and the saved login has no 2FA key: if it still needs one after you submit, call request_sign_in." : "";
  const who = login.source === "1password" ? " (from 1Password)" : "";
  return {
    ok: true, host: pageHost, loginId: login.id, filled,
    text: `Filled ${joinWords(filled.map((field) => FIELD_WORDS[field]))} for ${login.username || "the saved login"}${who} on ${pageHost}.${next}${note} You never see the password; do not read it back from the page.`,
  };
}
