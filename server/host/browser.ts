// The bots' browser as the server hosts it: the engine's runtime and live view, which session a bot's browser is, and
// the integration a turn mounts.
import type { AppConfig } from "../config.ts";
import { browserEngineAttachCdpUrl, browserProfilePartitionTarget, builtInBrowserEnabled } from "../config.ts";
import { BrowserRuntime, TransportError, attachesToChrome, browserRuntimeEnv, formatBrowserTiming } from "../browser-runtime.ts";
import { RelayTimeout, relayCommand } from "../browser-relay.ts";
import { browserSteps } from "../browser-steps.ts";
import { BrowserLive } from "../browser-live.ts";
import { browserEgress } from "../browser/egress/registry.ts";
import {
  agentBrowserIntegration,
  browserEngineEncryptionKey,
  prepareBrowserSessionState,
  clearBrowserSessionState,
  closeBrowserSession,
  browserEngineStatus,
  browserSessionId, isTemporaryBrowserSession,
  noteBrowserEngineUnavailable,
  setBrowserViewport,
} from "../browser-engine.ts";
import { BrowserSweep, browserIdleMs } from "../browser-lifecycle-cleanup.ts";
import { chromeLauncher } from "../browser/chrome/launcher.ts";
import { augmentedPath } from "../env-path.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { Store } from "../store.ts";
import type { TurnResources } from "../turn-resources.ts";

export interface BrowserHostDeps {
  cfg: AppConfig;
  /** The store is built after this host, so it is read when used. */
  store(): Pick<Store, "bots" | "bot">;
  turnResources: Pick<TurnResources, "free">;
  activeInternalGenerationByThread: ReadonlyMap<string, string>;
  mintInternalCapability(capability: {
    botId: string; threadId: string; generation: string; browserSession: string; kind: "browser";
    depth: number; skillAuthoring: boolean; createdBots: number; openedThreads: number;
  }): string;
  DESKTOP_MANAGED: boolean;
  CLOUD_HOME: unknown;
  PORT: number;
}

export function createBrowserHost(deps: BrowserHostDeps) {
  const { cfg, turnResources, activeInternalGenerationByThread, mintInternalCapability, DESKTOP_MANAGED, CLOUD_HOME, PORT } = deps;
  const store: Pick<Store, "bots" | "bot"> = { get bots() { return deps.store().bots; }, bot: (id: string) => deps.store().bot(id) };

  const browserRuntime = new BrowserRuntime({
    closeBrowser: async (session, spec) => {
      const closed = await closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }));
      if (closed) browserLive.closeForSession(session);
      return closed;
    },
    applyViewport: (spec) => setBrowserViewport(spec.command, spec.env),
    launch: chromeLauncher,
    relayCommand: (spec, session, command, timeoutMs) => relayCommand(spec, session, command, timeoutMs).catch((error: unknown) => {
      throw error instanceof RelayTimeout ? new TransportError(error.message) : error;
    }),
    steps: browserSteps,
    onTiming: process.env.OMB_BROWSER_TIMING === "1" ? (timing) => console.info(formatBrowserTiming(timing)) : undefined,
  });
  const browserLive = new BrowserLive({ runtime: browserRuntime });
  const usedBrowserSessions = new Map<string, { command: string; env: Record<string, string> }>();
  browserEgress.configure({ host: DESKTOP_MANAGED ? "desktop" : CLOUD_HOME ? "cloud" : "server", config: () => cfg.browserEngine?.egress });
  // The agent-browser daemon outlives its MCP transport and this server; My Chrome is the person's own.
  const browserSweep = new BrowserSweep({
    engine: () => { const engine = browserEngineStatus(); return engine.kind === "ready" ? engine.binaryPath : null; },
    owns: (session) => isTemporaryBrowserSession(session) || store.bots.some((bot) => browserSessionId(bot.id, "") === session)
      || (cfg.browserProfiles ?? []).some((profile) => !usesMyChrome(profile.id) && currentBrowserSession("", profile.id) === session),
    live: (session) => usedBrowserSessions.has(session),
    held: (session) => !turnResources.free(`browser:${session}`),
    closeIdle: (session) => browserRuntime.closeIfIdle(session, browserIdleMs(cfg), usedBrowserSessions.get(session)),
  });
  // The viewer and the agent must address the SAME temporary browser.
  const temporaryBrowserSessions = new Map<string, string>();
  function currentBrowserSession(botId: string, profile: string | undefined): string {
    if (profile === "guest") {
      let session = temporaryBrowserSessions.get(botId);
      if (!session) {
        session = browserSessionId(botId, "guest");
        temporaryBrowserSessions.set(botId, session);
      }
      return session;
    }
    const target = profile ? browserProfilePartitionTarget(cfg, profile) : null;
    return browserSessionId(botId, target?.partitionId ?? "");
  }
  async function forgetTemporaryBrowser(botId: string): Promise<void> {
    const session = temporaryBrowserSessions.get(botId);
    if (!session) return;
    temporaryBrowserSessions.delete(botId);
    usedBrowserSessions.delete(session);
    const engine = browserEngineStatus();
    if (engine.kind !== "ready") return;
    const closed = await clearBrowserSessionState(engine.binaryPath, session, {
      env: { PATH: augmentedPath() }, encryptionKey: browserEngineEncryptionKey(),
    });
    if (closed) await browserRuntime.close(session);
    else console.warn(`temporary browser ${session}: could not close its session; run agent-browser --session ${session} close on this server`);
  }
  function myChromeAvailable(): boolean {
    return DESKTOP_MANAGED || browserEngineAttachCdpUrl(cfg) !== null;
  }
  function usesMyChrome(profileId: string | undefined): boolean {
    return Boolean(profileId) && myChromeAvailable()
      && cfg.browserProfiles?.some((profile) => profile.id === profileId && profile.browser === "chrome") === true;
  }
  function browserSessionSpec(binaryPath: string, session: string, profile: string | undefined, egressPort?: number) {
    const attachCdpUrl = browserEngineAttachCdpUrl(cfg);
    return agentBrowserIntegration({
      binaryPath, session, encryptionKey: browserEngineEncryptionKey(), persistent: profile !== "guest", egressPort,
      env: { ...process.env, PATH: augmentedPath() },
      launcher: chromeLauncher.env(),
      ...(usesMyChrome(profile) ? { attach: attachCdpUrl ? { cdpUrl: attachCdpUrl } : {} } : {}),
    });
  }
  async function browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }) {
    const status = browserEngineStatus();
    if (status.kind !== "ready") {
      noteBrowserEngineUnavailable(status);
      return null;
    }
    const profileTarget = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
    const partitionId = profile === "guest" ? "guest" : (profileTarget?.partitionId ?? "");
    const session = currentBrowserSession(botId, profile);
    const browserProfileId = profileTarget?.profileId ?? profile;
    const spec = browserSessionSpec(status.binaryPath, session, browserProfileId, usesMyChrome(browserProfileId) ? undefined : await browserEgress.open(session));
    usedBrowserSessions.set(session, spec);
    await prepareBrowserSessionState(status.binaryPath, session, { env: spec.env, persistent: profile !== "guest" && !attachesToChrome(spec.env), isCurrent: () => {
      const current = store.bot(botId);
      return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
        && currentBrowserSession(current.id, current.browserProfile) === session
        && (!turn || activeInternalGenerationByThread.get(turn.threadId) === turn.generation);
    } });
    if (!turn) return { profile: partitionId, session, spec, integration: spec };
    const token = mintInternalCapability({ botId, ...turn, browserSession: session,
      kind: "browser", depth: 0, skillAuthoring: false, createdBots: 0, openedThreads: 0 });
    return { profile: partitionId, session, spec, integration: {
      command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: {
        ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("browser")]: token, OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      },
    } };
  }

  return {
    browserRuntime, browserLive, usedBrowserSessions, browserSweep, temporaryBrowserSessions,
    currentBrowserSession, forgetTemporaryBrowser, myChromeAvailable, usesMyChrome, browserSessionSpec, browserIntegration,
  };
}
