// The "agents" MCP server — spawned inside a bot's agent process (via the
// "agents" integration). Exposes the teammate, room, routine, memory and
// skill tools, each routed back through the harness so the harness stays the
// single owner of turns, permissions, and recursion limits.
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// permission-proxy). All state comes from env, injected by the harness when
// it builds the integration (catalogProfileFromEnv and
// toolCallContextFromEnv read it). The main ones:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
//   OMB_EXTERNAL_RUNTIME  "1" for a standing process: the same tools as every
//                    turn (the server's allow-list decides what it may call);
//                    only oversized results are cut instead of cached
//   OMB_CHIEF_OF_STAFF    "1" for a Chief of Staff, the only bot shown the Chief-only tools
//   OMB_AGENTS_TOOL_BRIDGE  "1" lists a few tools and puts the rest of the
//                    turn's tools behind find_tool and use_tool
//
// This file is the stdio front end only. What the tools are and which a turn
// sees: agents-catalog.ts. What a call does: agents-call.ts. How the harness
// is reached: agents-client.ts. How a turn's tools are listed when the bridge
// is on: agents-bridge.ts. The harness spawns THIS file as its own process
// (server/proxy-paths.ts), and scripts/bundle-server.mjs inlines the others
// into it, so a packaged build still ships one agents-proxy.js.
import readline from "node:readline";

import { TOOL_BRIDGE_ENV, createToolBridge } from "./agents-bridge.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { callTool, capResult, toolCallContextFromEnv } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

/** Everything this turn may call, however it is listed. */
const AVAILABLE_TOOLS = availableTools(catalogProfileFromEnv(process.env));
// With the switch off nothing is built: this process lists and answers as it
// always has, to the byte. The bridge's module and the ranker it searches
// with are loaded either way; a packaged proxy is about 16 KB larger for them.
const BRIDGE = process.env[TOOL_BRIDGE_ENV] === "1" ? createToolBridge(AVAILABLE_TOOLS) : undefined;
// A warm engine keeps this process across its turns; the harness keeps
// every per-turn limit, so nothing here counts.
const CONTEXT = toolCallContextFromEnv(process.env);

const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: BRIDGE ? BRIDGE.listed : AVAILABLE_TOOLS });
      return;
    case "tools/call": {
      const called = { name: params.name as string, arguments: (params.arguments ?? {}) as Json };
      // find_tool is answered by the bridge, and use_tool becomes the tool it
      // names. From here a bridged call is a direct one: the same
      // unknown-tool check, the same callTool, the same bounds on its result.
      const bridged = BRIDGE ? await BRIDGE.route(called.name, called.arguments) : undefined;
      if (bridged && "answer" in bridged) return textResult(id, bridged.answer.text, bridged.answer.isError);
      const { name, arguments: args } = bridged ?? called;
      if (!AVAILABLE_TOOLS.some((t) => t.name === name)) {
        // One check and one sentence, whichever way the name came. A name
        // the engine sent is a protocol error, as it always was. One a model
        // wrote into use_tool is that call failing: every engine hands a
        // failed call back to the model, while the chat runtime ends the
        // turn on a protocol error (chat-mcp-tools.ts), which a wrong guess
        // at a name must not do.
        const unknown = `Unknown tool: ${name}`;
        return bridged ? textResult(id, unknown, true) : rpcErr(id, -32602, unknown);
      }
      try {
        const { text, isError, passthrough } = await callTool(name, args, CONTEXT);
        if (passthrough) ok(id, passthrough);
        else textResult(id, name === "tool_result_read" ? text : await capResult(text, CONTEXT), isError);
      } catch (e) {
        textResult(id, await capResult((e as Error).message, CONTEXT), true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
