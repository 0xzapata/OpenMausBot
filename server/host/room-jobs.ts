// Work handed to members of a room (coordinate_bots): who waits in each room
// thread's line and on whom, what the requester is told about it, and the
// opt-in parallel room jobs, where each job runs in a thread of its own on
// its member beside the room ("lane"), posts its result card back into the
// room, and the requester resumes once with every result.
import type { AppConfig } from "../config.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { peerDeliveryReceipt, type PeerDeliveryReceipt } from "../peer-delivery.ts";
import { peerName } from "../peer-roster.ts";
import { queuedJobDetail, roomQueue, sequentialRoomNotice, type RoomLineItem } from "../room-queue.ts";
import type { GroupRecord, Store } from "../store.ts";
import type { RoomQueueEntry } from "../../shared/wire.ts";

/** A round of @mentioned responders, in the order they reply: the one
 * replying now and those still waiting. */
export interface RoomRoundLine { current?: string; pending: string[] }

export interface RoomJobsDeps {
  store: Store;
  /** Read lazily: index.ts builds the coordinator after this module. */
  coordinator: Pick<Coordinator, "all">;
  cfg: AppConfig;
  /** The room's live turn operations (a round of responders carries its line). */
  operations: (groupId: string) => Iterable<{ threadId: string; cancelled: boolean; line?: RoomRoundLine }>;
  /** The member speaking in a room thread, if any. */
  speakerOf: (threadId: string) => string | undefined;
  laneRoomThread: (n: Pick<HandoffView, "botId" | "threadId" | "groupId">) => string | undefined;
}

/** Parallel room jobs: when a requester hands work to several members of a
 * room at once (or into a room whose members are already working through
 * a line of jobs), each job runs in a thread of its own on that member,
 * beside the room, and posts its result card back into the room; the
 * requester resumes once with every result. Off by default, where same-room
 * jobs take turns in the room's own thread. Enabled in
 * ~/.openmausbot/config.json (`{"features": {"parallelRoomJobs": true}}`)
 * or with PATCH /api/config. */
export function parallelRoomJobsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.parallelRoomJobs === true;
}

const live = (n: HandoffView) => n.parentId !== undefined && (n.status === "queued" || n.status === "running");

export function createRoomJobs({ store, coordinator, cfg, operations, speakerOf, laneRoomThread }: RoomJobsDeps) {
  /** Who waits in each of the room's threads, in the order they will run: the
   * round of @mentioned responders first (it holds the thread's queue), then
   * work handed into the room, which runs after it one job at a time. */
  function roomLineOf(record: GroupRecord): RoomQueueEntry[] {
    const items: RoomLineItem[] = [];
    for (const operation of operations(record.id)) {
      if (operation.cancelled || !operation.line) continue;
      const { current, pending } = operation.line;
      if (current) items.push({ botId: current, threadId: operation.threadId, state: "running" });
      for (const botId of pending) items.push({ botId, threadId: operation.threadId, state: "queued" });
    }
    const jobs = coordinator.all().filter(n => n.groupId === record.id && live(n)).sort((a, b) => a.createdAt - b.createdAt);
    for (const n of jobs) items.push({ botId: n.botId, threadId: n.threadId, state: n.status === "running" ? "running" : "queued", assignmentId: n.id });
    const speakers = new Map<string, string>();
    for (const threadId of new Set(items.map(item => item.threadId))) {
      const speaker = speakerOf(threadId);
      if (speaker) speakers.set(threadId, speaker);
    }
    return roomQueue(items, speakers);
  }

  /** The round's next responder starts: the line moves up. True when the
   * room's payload changed. */
  function advanceRound(operation: { line?: RoomRoundLine }, current: string | undefined, spoken: ReadonlySet<string>): boolean {
    if (!operation.line) return false;
    operation.line = { ...(current ? { current } : {}), pending: operation.line.pending.filter(id => id !== current && !spoken.has(id)) };
    return true;
  }

  /** Parallel room jobs (features.parallelRoomJobs): same-room speakers take
   * turns, so work for several members, or for a room already working
   * through a line of jobs, would run one job at a time. With the flag on
   * each job runs in a lane instead. A single job into a quiet room, and a
   * one-way notice, still run in the room. */
  function useLanes(room: GroupRecord, roomThreadId: string, jobs: number, mode: string): boolean {
    if (mode === "notify" || !parallelRoomJobsEnabled(cfg)) return false;
    return jobs > 1 || coordinator.all().some(n => live(n) && (n.groupId === room.id ? n.threadId === roomThreadId : laneRoomThread(n) === roomThreadId));
  }

  /** The member's lane for jobs from this room thread: one per member and
   * requester, so a member's jobs run there in turn and never two at once.
   * Opened by the requester from the room, in the room's working folder. */
  function openLane(room: GroupRecord, roomThreadId: string, botId: string, sender: { id: string; name: string }, brief: string) {
    const existing = store.workThread(botId, sender.id, roomThreadId, true);
    const snippet = brief.replace(/\s+/g, " ").trim().slice(0, 48);
    const task = existing ?? store.createTask(botId, `${room.name} · ${snippet || "room job"}`, false, undefined,
      { botId: sender.id, name: sender.name, threadId: roomThreadId, kind: "work", roomLane: true, at: Date.now() },
      undefined, undefined, store.pinGroupCwd(room.id, roomThreadId) ?? undefined);
    if (!task) throw new Error("The recipient no longer exists");
    return { threadId: task.threadId, title: task.title, created: !existing };
  }

  /** What the requester reads about its room jobs: a job that waits its turn
   * says where it stands, and the message says whether they run in turn or
   * side by side, so it does not tell the person five jobs are under way
   * when one is. Rewrites the waiting receipts in place; returns the lead
   * line for the message ("" when there is nothing to say). */
  function describeRoomJobs(room: GroupRecord, roomThreadId: string, receipts: PeerDeliveryReceipt[],
    options: { senderId: string; returns: string; lanes: boolean; awaited: boolean }): string {
    const nameOf = (botId: string) => botId === options.senderId ? "your own turn" : peerName(store.bot(botId)?.name ?? "") || "a teammate";
    const line = roomLineOf(room).filter(entry => entry.threadId === roomThreadId);
    for (const [index, receipt] of receipts.entries()) {
      const entry = line.find(candidate => candidate.assignmentId === receipt.requestId && candidate.state === "queued");
      if (!entry || receipt.outcome !== "queued") continue;
      receipts[index] = peerDeliveryReceipt({ ...receipt, detail: `${queuedJobDetail(entry, nameOf)}; ${options.returns}`,
        queue: { position: entry.position, of: entry.of, ...(entry.waitingForBotId ? { waitingFor: nameOf(entry.waitingForBotId) } : {}) } });
    }
    const parallel = options.lanes && options.awaited
      ? "These run in parallel, each in a thread of its own beside this room; each posts its result card here when it finishes, and you resume once with all of them."
      : undefined;
    const sequential = sequentialRoomNotice(line, new Set(receipts.flatMap(receipt => receipt.requestId ? [receipt.requestId] : [])), nameOf);
    return [parallel, sequential].filter(Boolean).join(" ");
  }

  return { roomLineOf, advanceRound, useLanes, openLane, describeRoomJobs };
}
