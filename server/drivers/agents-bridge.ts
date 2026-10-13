// The agents tool bridge: a turn's rarely used tools behind two of the
// proxy's own, so they are not sent to the model on every turn.
//
// The catalog (agents-catalog.ts) is trimmed by role and feature but not by
// need: 27 to 39 tools, 43 to 57 KB of JSON, ride every turn of every bot,
// though most turns call two or three of them. With the bridge on, tools/list
// answers with a short hot list as it stands plus:
//   find_tool  searches the rest of THIS turn's profile; each match comes
//              back with its name, its description and its full input schema
//   use_tool   runs one tool of the profile by name
//
// What it must not change is who may do what. The profile a turn was given
// is still the whole of what it can call: use_tool hands a name and its
// arguments back to the proxy, whose one unknown-tool check and one callTool
// path then treat it as a direct call, no stricter and no looser. Nothing
// about a tool is checked here that a direct call is not checked for; the
// harness refuses what a profile's schema merely leaves out (a Chief-only
// for_bot_id, a place a Cloud home does not have).
//
// A call made through use_tool carries the name use_tool, though, and three
// kinds of rule read a call's NAME. Each is kept out of the bridge's way
// rather than taught about it:
//   - The host's own classifier of outward actions (shared/outbound.ts
//     isOutboundTool): the restart policy does not rerun a cut turn that
//     already sent or posted something (docs/runtime-contract.md §5). A tool
//     it calls outward is always listed and never runs through use_tool:
//     calledByItsOwnName.
//   - A bot's tool selection (shared/tool-scope.ts), enforced by gates that
//     match the outer name. Wherever one is mounted in front of the agents
//     server, that server is started unbridged, whatever the turn decided
//     earlier (unbridgedServer; mcp-gate-config.ts, chat-mcp-tools.ts), and
//     the gate judges a use_tool call by the tool it names as well
//     (bridgedCallTarget; mcp-gate.ts).
//   - Rules an engine keeps itself: a deny pattern, a permission remembered
//     for a session. So a turn is bridged only on an engine where the
//     harness pre-approves the whole agents server and no such rule can name
//     one of its tools (server/agents-bridge-switch.ts, docs/agents-tool-bridge.md).
//
// Definitions and pure logic only: no environment, no harness calls, nothing
// heavier than the ranker the remote directory already uses. The proxy, the
// gate and the server all import it.
import { isOutboundTool } from "../../shared/outbound.ts";
import { READ_ONLY_ANNOTATIONS } from "../agent-tool-policy.ts";
import { bm25Ranker } from "../mcp-directory.ts";
import type { Json } from "./agents-client.ts";

/** What the harness writes into a turn's agents integration and the proxy
 * reads: "1" lists through the bridge, anything else lists the catalog. */
export const TOOL_BRIDGE_ENV = "OMB_AGENTS_TOOL_BRIDGE";
export const FIND_TOOL = "find_tool";
export const USE_TOOL = "use_tool";

/** One tool as tools/list serializes it. A type alias, not an interface: the
 * shared ranker takes any tool definition as an open record (CatalogTool in
 * mcp-directory.ts), which an object type satisfies and an interface does not. */
export type BridgeTool = {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: unknown;
};

/** What a bridge tool answers itself, when it runs nothing. */
export interface BridgeAnswer {
  text: string;
  isError?: boolean;
}

/** What one bridge call comes to: the tool to run, or the answer to give. */
export type BridgeRoute = { name: string; arguments: Json } | { answer: BridgeAnswer };

/** The tools that stay listed. A bot needs these in most turns, or must be
 * able to reach them without a detour to stay inside the rules:
 *
 *   create_options_card the Watcher bot's question to the person; only
 *                       Watcher's profile has it.
 *   tool_result_read    the rest of an oversized result. Its notice names
 *                       this tool and says not to repeat the action instead.
 *   list_room_targets   the teammates and rooms coordinate_bots can address;
 *                       its description and the room prompt send a bot here.
 *   coordinate_bots     the one way to hand work on; every team prompt and
 *                       every hand-off result points at it.
 *   list_bots           the teammate ids coordinate_bots takes; its
 *                       description and dozens of refusals name it.
 *   list_rooms          post_to_room's group_id comes from nowhere else.
 *   select_computer     the way to a screen: nothing can be done on a
 *                       computer or in the browser before it connects one.
 *   attach_file         how a reply carries a file to the person.
 *   post_to_room        what a bot tells a room, and an outward action.
 *   request_credential  asks the person for an API key through the secure
 *                       card, never in chat.
 *   request_sign_in     asks the person to sign in themselves; the rule is
 *                       never to ask for a password in chat.
 *   fill_login          signs in with a saved login the bot never sees.
 *   send_voice_note     how a reply carries a voice note (when the bot has a
 *                       voice), and an outward action.
 *   memory_update       the only sanctioned write to MEMORY.md, which other
 *                       threads write too.
 *
 * The catalog has no general ask-the-person tool: that is the engine's own
 * (AskUserQuestion, ask_user). The Watcher's card and the three request_* /
 * fill_login tools are how these tools put something in front of the person.
 *
 * Anything else the host counts as an outward action is listed as well,
 * whether or not it is named here (calledByItsOwnName). */
export const BRIDGE_HOT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_options_card",
  "tool_result_read",
  "list_room_targets",
  "coordinate_bots",
  "list_bots",
  "list_rooms",
  "select_computer",
  "attach_file",
  "post_to_room",
  "request_credential",
  "request_sign_in",
  "fill_login",
  "send_voice_note",
  "memory_update",
]);

/** How many matches one search returns. Each carries its full input schema,
 * so few: the point of the bridge is what does not ride along. */
export const FIND_MATCHES_MAX = 3;
/** One search answers in at most this many characters of tool definitions.
 * The proxy cuts a result at 24,000 (agents-result.ts), and a schema cut in
 * half is not a schema; the first match is always whole. */
const FIND_CHARS_MAX = 20_000;
const QUERY_CHARS = 1_000;
/** The names of the hidden tools in find_tool's own description. */
export const BRIDGE_NAMES_MAX_CHARS = 1_200;
/** Room kept to say how many names were left out. */
const MORE_NAMES_CHARS = 24;

function record(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The agents server's name in front of one of its tools, as each engine
 * spells it: Claude's `mcp__agents__`, an ACP agent's `agents__`, the chat
 * runtime's and Pi's `agents_`, or nothing (Codex names the tool alone). */
const SERVER_PREFIXES = ["", "mcp__agents__", "agents__", "agents_"] as const;

/** A tool the host recognizes as an outward action by its name, under any
 * spelling an engine reports it in a turn's activity or a permission
 * request. It must appear under that name, so it is always listed and
 * use_tool will not run it. Derived from the host's classifier rather than
 * listed here, so a tool added later cannot be hidden by forgetting to say so. */
function calledByItsOwnName(name: string): boolean {
  return SERVER_PREFIXES.some((prefix) => isOutboundTool(`${prefix}${name}`));
}

/** The tool a use_tool call names, for a gate that judges a call by its
 * name: undefined for any other call, and for a use_tool that names none
 * (the bridge answers that one itself and runs nothing). */
export function bridgedCallTarget(name: string, args: unknown): string | undefined {
  const target = name === USE_TOOL && record(args) ? args.name : undefined;
  return typeof target === "string" && target.trim() ? target : undefined;
}

/** The name a tool call is known by once the harness has seen it: a use_tool
 * call on the agents server reads as the tool it ran, in the engine's own
 * spelling (`mcp__agents__use_tool` naming list_routines is
 * `mcp__agents__list_routines`), so a row, a work summary and the restart
 * policy's evidence all say what happened. `input` is the call's arguments,
 * or the preview a driver made of them (tool-summary.ts toolDetailPreview:
 * indented JSON, cut when long). A call whose inner name is missing, cut off
 * or not one of the catalog's tools keeps the name it came with; so does a
 * very large call that put its arguments before its name, whose preview ends
 * before the name is reached. `bare` false leaves a title with no server in
 * it alone: a plain `use_tool` could be any server's. */
export function bridgedCallTitle(title: string, input: unknown, isCatalogTool: (name: string) => boolean, bare = true): string {
  const prefix = SERVER_PREFIXES.find((spelling) => title === `${spelling}${USE_TOOL}`);
  if (prefix === undefined || (prefix === "" && !bare)) return title;
  let args = input;
  if (typeof input === "string") {
    try {
      args = JSON.parse(input);
    } catch {
      // A preview cut short is not JSON; its top-level keys still sit at
      // exactly two spaces, which no nested key does.
      args = { name: /^ {2}"name": "([^"\\]+)",?$/m.exec(input)?.[1] };
    }
  }
  const inner = bridgedCallTarget(USE_TOOL, args);
  return inner !== undefined && isCatalogTool(inner) ? `${prefix}${inner}` : title;
}

/** An agents server spec that will list its whole catalog whatever it was
 * built to do: for a mount whose tool selection matches the name in the
 * call. Any other server, and one that was never told about the bridge,
 * comes back as it is. */
export function unbridgedServer<Spec extends { env?: Record<string, string> }>(server: Spec): Spec {
  return server.env && Object.hasOwn(server.env, TOOL_BRIDGE_ENV) && server.env[TOOL_BRIDGE_ENV] !== "0"
    ? { ...server, env: { ...server.env, [TOOL_BRIDGE_ENV]: "0" } }
    : server;
}

/** Whether the agents integration a turn mounts was asked to list through
 * the bridge: read off the very environment its proxy is started with. A
 * mount with a tool selection may still start it unbridged, so what a turn
 * is told on the strength of this has to hold either way. */
export function agentsToolBridged(agents: { env?: Record<string, string | undefined> } | undefined): boolean {
  return agents?.env?.[TOOL_BRIDGE_ENV] === "1";
}

/** `a, b, c.` within maxChars, or `a, b, … and 12 more.` Names are never cut. */
function namesList(names: readonly string[], maxChars: number): string {
  if (!names.length) return "none.";
  let text = "";
  let shown = 0;
  for (const name of names) {
    const part = `${shown ? ", " : ""}${name}`;
    const last = shown === names.length - 1;
    if (text.length + part.length + (last ? 1 : MORE_NAMES_CHARS) > maxChars) break;
    text += part;
    shown += 1;
  }
  return shown < names.length ? `${text}${shown ? ", " : ""}… and ${names.length - shown} more.` : `${text}.`;
}

const FIND_USAGE = `${FIND_TOOL} needs { "query": "what you want to do, in a few words" }, for example "schedule a routine", or a tool's exact name.`;
const USE_USAGE = `${USE_TOOL} needs { "name": "the tool's exact name", "arguments": { ... } }, with arguments a JSON object as the tool's input schema describes it. Find the name and the schema with ${FIND_TOOL}.`;
const HOW_TO_RUN = `Run one with ${USE_TOOL}({ "name": "...", "arguments": { ... } }), with arguments that fit its inputSchema. Follow its description as you would for a tool in your list.`;

export interface ToolBridge {
  /** What tools/list answers: the hot tools as they stand, in catalog order,
   * then find_tool and use_tool. */
  readonly listed: readonly BridgeTool[];
  /** The rest of the profile, in catalog order: what find_tool searches. */
  readonly hidden: readonly BridgeTool[];
  find(args: unknown): Promise<BridgeAnswer>;
  use(args: unknown): BridgeRoute;
  /** One tools/call: a bridge tool is answered or resolved to the tool it
   * runs. Undefined for any other name, which is called as it came. */
  route(name: string, args: Json): Promise<BridgeRoute | undefined>;
}

/** The bridge over one turn's profile: `tools` is availableTools(profile),
 * the whole of what the turn may call. */
export function createToolBridge(tools: readonly BridgeTool[]): ToolBridge {
  const profile = new Set(tools.map((tool) => tool.name));
  const hot = tools.filter((tool) => BRIDGE_HOT_TOOL_NAMES.has(tool.name) || calledByItsOwnName(tool.name));
  const hotNames = new Set(hot.map((tool) => tool.name));
  const hidden = tools.filter((tool) => !hotNames.has(tool.name));

  const listed: BridgeTool[] = [
    ...hot,
    {
      name: FIND_TOOL,
      description: `Find an OpenMausBot tool that is not in your tool list. Say what you want to do in a few words, or give the tool's name. Each match comes back with its description and exact input schema; run one with ${USE_TOOL}. A tool in your tool list is called directly, not found here. Tools reached this way: ${namesList(hidden.map((tool) => tool.name), BRIDGE_NAMES_MAX_CHARS)}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "What you want to do, in a few words, or a tool's exact name." },
        },
        required: ["query"],
      },
      // A search of this turn's own tool list: the read the catalog's
      // reviewed reads are marked as.
      annotations: READ_ONLY_ANNOTATIONS,
    },
    {
      name: USE_TOOL,
      description: `Run one OpenMausBot tool that ${FIND_TOOL} gave you, by its exact name, with its input as arguments. It runs exactly as if you had called it directly: the same permissions, limits and refusals apply, and its result comes back unchanged. Read the tool's description and input schema from ${FIND_TOOL} before the first call.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: `The tool's exact name, as ${FIND_TOOL} gave it.` },
          // One flat object with no branches (see ROUTINE_SCHEDULE_SCHEMA in
          // agents-catalog.ts); the tool itself reads what is in it.
          arguments: { type: "object", additionalProperties: true, description: `The tool's input, as the input schema ${FIND_TOOL} returned describes it. Leave out for a tool that takes none.` },
        },
        required: ["name"],
      },
    },
  ];
  const listedNames = new Set(listed.map((tool) => tool.name));

  async function find(args: unknown): Promise<BridgeAnswer> {
    const query = record(args) && typeof args.query === "string" ? args.query.trim() : "";
    // A search that could not be made is a failed call, as any tool's
    // malformed input is: it must not read as progress.
    if (!query || query.length > QUERY_CHARS) return { text: FIND_USAGE, isError: true };
    if (listedNames.has(query)) return { text: `${query} is in your tool list: call it directly.` };
    // Okapi BM25 over each tool's name, its description and, at half weight,
    // the words of its input schema; an exact name ranks first. The ranker
    // the remote proxy's directory uses, so one search behaves like the other.
    const ranked = await bm25Ranker(query, hidden, FIND_MATCHES_MAX);
    const matches: Array<Pick<BridgeTool, "name" | "description" | "inputSchema">> = [];
    let chars = 0;
    for (const candidate of ranked.slice(0, FIND_MATCHES_MAX)) {
      // Only ever a tool of this turn's profile, whatever a ranker returns.
      const tool = hidden.find((entry) => entry.name === candidate.name);
      if (!tool) continue;
      // What the unbridged turn lists for it and a model can use: the whole
      // description, which carries the tool's rules, and this turn's own
      // schema. Annotations are for the engine, which never sees these.
      const match = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
      const size = JSON.stringify(match).length;
      if (matches.length && chars + size > FIND_CHARS_MAX) break;
      matches.push(match);
      chars += size;
    }
    return { text: JSON.stringify(matches.length
      ? { matches, next: HOW_TO_RUN }
      : { matches, next: `Nothing matched. Try other words, or one of these names: ${namesList(hidden.map((tool) => tool.name), BRIDGE_NAMES_MAX_CHARS)} A tool in your tool list is called directly.` }) };
  }

  // A call that was asked for and did not run is a failed call. Only the
  // shape of the call itself is checked: the tool reads its own arguments,
  // exactly as it does when it is called directly.
  function use(args: unknown): BridgeRoute {
    const name = record(args) && typeof args.name === "string" ? args.name : "";
    const input = record(args) ? args.arguments : undefined;
    if (!name.trim() || (input != null && !record(input))) return { answer: { text: USE_USAGE, isError: true } };
    // Not one of this turn's tools: no answer here. The proxy's one
    // unknown-tool check refuses it, with the words it has for the same name
    // called directly, so the two can never come to differ.
    if (profile.has(name) && calledByItsOwnName(name)) {
      return { answer: { text: `${name} is in your tool list: call it directly, not through ${USE_TOOL}. Nothing was run.`, isError: true } };
    }
    return { name, arguments: input ?? {} };
  }

  async function route(name: string, args: Json): Promise<BridgeRoute | undefined> {
    if (name === FIND_TOOL) return { answer: await find(args) };
    if (name === USE_TOOL) return use(args);
    return undefined;
  }

  return { listed, hidden, find, use, route };
}
