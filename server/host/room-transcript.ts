// The room's recent conversation as one member's turn reads it.
//
// A room turn carries the room's last lines in its own text, each on a
// speaker line: the person's (by name, and marked when it came through the
// API rather than being typed), a member's final message of a settled turn
// (never its working notes, room-reply.ts), another bot's post_to_room
// under its provenance note, a turn's digest and a teammate's report. Every
// line has imitations of a harness note defused (escapeNotes).
//
// A host module (server/host/README.md): it reads the store it is handed and
// nothing else. The teammate report is resolved by the caller, which owns
// the coordinator and rechecks access for the reader.
import { DRAIN_COALESCE_MAX_ITEMS } from "../admission.ts";
import { digestPromptLine } from "../digest.ts";
import { escapeNotes, peerProvenanceNote } from "../peer-provenance.ts";
import { peerName } from "../peer-roster.ts";
import { transcriptText } from "../replies.ts";
import { roomTurnNarrationIds } from "../room-reply.ts";
import type { Store } from "../store.ts";

// The room-context window IS the drain's coalescing cap: a burst longer
// than the window would append transcript lines the responder never reads,
// so both bounds come from one constant (admission.ts).
export const GROUP_CONTEXT_MESSAGES = DRAIN_COALESCE_MAX_ITEMS;

export interface RoomTranscriptDeps {
  store: Pick<Store, "messagesFor">;
  /** A teammate's report for this reader, or the line that says it is
   * withheld: resolved from the coordinator, which stays with the caller. */
  teammateReportContext(requestId: string, readerBotId?: string): string;
}

export function createRoomTranscript({ store, teammateReportContext }: RoomTranscriptDeps) {
  function serializeRoomContext(
    threadId: string,
    userName: string,
    textOverrides?: ReadonlyArray<{ messageId: string; text: string }>,
    readerBotId?: string,
  ): string {
    const messages = store.messagesFor(threadId);
    const messagesById = new Map(messages.map((message) => [message.id, message]));
    const overrides = new Map(textOverrides?.map((override) => [override.messageId, override.text]));
    // A settled member turn speaks to the room through its final message;
    // its working notes are not its answer (room-reply.ts).
    const narration = roomTurnNarrationIds(messages);
    return messages
      .filter((m) => !narration.has(m.id))
      .filter((m) => (m.kind === "text" && m.text) || (m.kind === "digest" && m.digest) || m.roomRequest?.phase === "result")
      .slice(-GROUP_CONTEXT_MESSAGES)
      .map((m) => {
        if (m.kind === "digest" && m.digest) {
          return digestPromptLine(m.digest, m.from ? peerName(m.from.name) : "a bot");
        }
        if (m.roomRequest?.phase === "result") {
          // Keep the chat receipt small without erasing the report from later
          // turns. Resolve from the existing bounded store and recheck access.
          return teammateReportContext(m.roomRequest.id, readerBotId);
        }
        const overridden = overrides.get(m.id);
        const rendered = overridden !== undefined ? { ...m, text: overridden } : m;
        // a bot's name is quoted on the speaker line, so it gets one line; a
        // user line that came through the API says so, since the reader would
        // otherwise take it for the person typing
        const person = m.sender?.name ?? userName;
        const speaker = m.role === "user"
          ? m.via === "api" ? `${person} (sent through the local API, not typed)` : person
          : m.from ? peerName(m.from.name) : "Bot";
        const line = `${speaker}: ${escapeNotes(transcriptText(rendered, messagesById, userName))}`;
        // A room reply is the room talking. A post_to_room message is another
        // bot's text carried in from somewhere else, so it says so — the
        // reader's own posts excepted, which would only be telling it about
        // itself.
        if (!m.peerPost || !m.from || m.from.botId === readerBotId) return line;
        return `${peerProvenanceNote({ botName: m.from.name, delivery: "post_to_room", unattended: m.peerPost.unattended })}\n${line}`;
      })
      .join("\n");
  }

  return { serializeRoomContext };
}
