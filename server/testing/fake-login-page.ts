// A stand-in for the bot's browser in fill_login tests: one happy-dom page answering the engine commands
// login-fill sends and taking typed text like the input relay. It records every engine command, so a
// test can prove no secret went through one.
import { Window } from "happy-dom";

export class FakeLoginPage {
  window: Window;
  /** Every engine command, as its argument list. */
  readonly engineCalls: string[][] = [];
  /** Every text typed through the input relay. */
  readonly typed: string[] = [];
  /** What the page's scripts saw: field name → the last value an input event carried. */
  readonly state: Record<string, string> = {};
  streamEnabled = false;
  readonly streamPort = 19_977;

  constructor(url: string, html: string) {
    this.window = this.open(url, html);
  }

  private open(url: string, html: string): Window {
    const window = new Window({ url, settings: { disableJavaScriptEvaluation: false } });
    window.document.body.innerHTML = html;
    window.document.addEventListener("input", (event) => {
      const target = event.target as unknown as { name?: string; id?: string; value?: string };
      this.state[target.name || target.id || "?"] = target.value ?? "";
    });
    return window;
  }

  navigate(url: string, html: string): void {
    void this.window.happyDOM.close();
    this.window = this.open(url, html);
  }

  field(selector: string): { value: string } {
    return this.window.document.querySelector(selector) as unknown as { value: string };
  }

  /** What the engine answers: its `data`, or null for a stopped browser. */
  async engine(args: string[]): Promise<Record<string, unknown> | null> {
    this.engineCalls.push(args);
    if (args[0] === "get" && args[1] === "url") return { url: this.window.location.href };
    if (args[0] === "eval") return { result: this.window.eval(args[1]!) as unknown };
    if (args[0] === "stream" && args[1] === "status") return this.streamEnabled ? { enabled: true, port: this.streamPort } : { enabled: false };
    if (args[0] === "stream" && args[1] === "enable") { this.streamEnabled = true; return { enabled: true, port: this.streamPort }; }
    throw new Error(`unexpected engine command: ${args[0]}`);
  }

  /** `keyboard insertText` over the relay: into the focused field at its caret, with beforeinput and input events. */
  async insertText(text: string): Promise<void> {
    this.typed.push(text);
    const field = this.window.document.activeElement as unknown as { value: string; dispatchEvent(event: unknown): boolean } | null;
    if (!field || typeof field.value !== "string") return;
    const InputEvent = this.window.InputEvent;
    field.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, data: text, inputType: "insertText" }));
    field.value += text;
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }

  close(): void {
    void this.window.happyDOM.close();
  }
}

export const LOGIN_FORM = `
  <form action="/session" method="post">
    <label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
    <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
    <input type="hidden" name="csrf" value="token-not-a-secret">
    <button type="submit">Sign in</button>
  </form>
  <form role="search"><input name="q" type="search"></form>`;
