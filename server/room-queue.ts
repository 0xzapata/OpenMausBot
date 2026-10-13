// A room thread's line of work: who is running in it and who waits, in the
// order they will run. Same-room speakers take turns (runtime.ts
// dispatchDue, the round loop in startGroupTurn), so five jobs sent into one
// room run one after another. Nothing in the room said so: a waiting member
// looked idle and a requester read "queued" as "under way". This projection
// is what the room payload (WireGroup.queue) and coordinate_bots receipts
// report instead: "Queued · waiting for Ada (2 of 5)".
import type { RoomQueueEntry } from "../shared/wire.ts";

/** One member's place in a line, as the host knows it. */
export interface RoomLineItem {
  botId: string;
  /** The room thread whose line this is. */
  threadId: string;
  state: "running" | "queued";
  /** The assignment, for a coordinate_bots job; absent for an @mention. */
  assignmentId?: string;
}

/**
 * Number each room thread's line. `items` arrive in the order the host will
 * run them; running items move to the front (stable), so a line reads
 * "running, then queued in turn". `speakers` names the member speaking in a
 * thread outside any job (a requester's own turn): the first queued item,
 * with nothing running, waits on that member. A line with nothing queued is
 * not a line, and is left out: the speaker presence already shows it.
 */
export function roomQueue(items: readonly RoomLineItem[], speakers: ReadonlyMap<string, string> = new Map()): RoomQueueEntry[] {
  const lines = new Map<string, RoomLineItem[]>();
  for (const item of items) {
    const line = lines.get(item.threadId) ?? [];
    // One place per member per thread: a member already in the line keeps
    // its first place (a job and a mention for one member are one wait),
    // running if either is, and the job's assignment id, which receipts and
    // the requester's notice look it up by.
    const index = line.findIndex(other => other.botId === item.botId);
    const placed = line[index];
    if (!placed) line.push(item);
    else line[index] = { ...placed, ...(item.state === "running" ? { state: "running" as const } : {}),
      ...(!placed.assignmentId && item.assignmentId ? { assignmentId: item.assignmentId } : {}) };
    lines.set(item.threadId, line);
  }
  const entries: RoomQueueEntry[] = [];
  for (const [threadId, raw] of lines) {
    const line = [...raw.filter(item => item.state === "running"), ...raw.filter(item => item.state === "queued")];
    if (!line.some(item => item.state === "queued")) continue;
    // A queued member waits on the one running now; with nothing running
    // yet, the first waits on whoever speaks (the requester's own turn) and
    // each after it on the one ahead.
    const running = line.find(item => item.state === "running");
    const speaker = speakers.get(threadId);
    line.forEach((item, index) => {
      const ahead = index > 0 ? line[index - 1]!.botId : undefined;
      const waitingFor = item.state === "running" ? undefined
        : running?.botId ?? ahead ?? (speaker !== item.botId ? speaker : undefined);
      entries.push({
        botId: item.botId, threadId, state: item.state, position: index + 1, of: line.length,
        ...(waitingFor ? { waitingForBotId: waitingFor } : {}),
        ...(item.assignmentId ? { assignmentId: item.assignmentId } : {}),
      });
    });
  }
  return entries;
}

/** A receipt's line for a job that waits its turn in a room. */
export function queuedJobDetail(entry: RoomQueueEntry, nameOf: (botId: string) => string): string {
  const after = entry.waitingForBotId ? `, after ${nameOf(entry.waitingForBotId)}` : "";
  return `queued ${entry.position} of ${entry.of} in this room: room jobs run one at a time, so it starts in turn${after}`;
}

/**
 * What coordinate_bots tells a requester whose room jobs will run one after
 * another, so it does not tell the person they are all under way. Undefined
 * when nothing it sent has to wait behind other room work.
 */
export function sequentialRoomNotice(line: readonly RoomQueueEntry[], sent: ReadonlySet<string>, nameOf: (botId: string) => string): string | undefined {
  const waiting = line.filter(entry => entry.state === "queued" && entry.assignmentId !== undefined && sent.has(entry.assignmentId));
  if (!waiting.length || line.length < 2) return undefined;
  const order = line.map(entry => `${nameOf(entry.botId)} (${entry.position} of ${entry.of}${entry.state === "running" ? ", running" : ""})`).join(", ");
  return `These run one at a time in this room, not in parallel: ${order}. Tell the person they are queued and run in turn; do not say they are all under way or dispatched in parallel.`;
}
