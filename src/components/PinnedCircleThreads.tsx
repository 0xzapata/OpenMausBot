import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FolderPlus, Plus } from "lucide-react";
import { openBot, visibleMessages, type Bot, type Message } from "@/state/store";
import { avatarCropRadius, botAvatarProfile } from "../../shared/bot-avatar";
import { liveActivityLabel } from "@/lib/live-activity";
import { BotAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { searchMatchesThreads, useSearchDisclosure } from "@/lib/search-disclosure";
import { lastNonReceipt } from "@/lib/receipts";
import { t } from "@/lib/i18n";
import { BotProjectDialog } from "./BotProjects";
import { useShowThreads } from "@/lib/thread-preferences";
import { sidebarBotActivityTasks } from "./SidebarBotActivity";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { BotThreadList, type BotRowProps } from "./Sidebar";

function useVisibleMessages(bot: Bot): Message[] {
  const { messages, activeLeafId } = bot;
  return useMemo(() => visibleMessages({ messages, activeLeafId }), [messages, activeLeafId]);
}

function botHasThreadList(bot: Pick<Bot, "tasks" | "projects">, query: string): boolean {
  return (bot.tasks?.filter((task) => !task.routineRunId).length ?? 1) > 1
    || (bot.projects?.length ?? 0) > 0
    || Boolean(query);
}

function threadListQuery(bot: Pick<Bot, "name" | "title">, query: string): string {
  const q = query.toLowerCase();
  return bot.name.toLowerCase().includes(q) || bot.title.toLowerCase().includes(q) ? "" : query;
}

function pinnedCircleThreadPanelId(botId: string): string {
  return `pinned-circle-threads-${botId}`;
}

/** Columns of `repeat(auto-fill, minmax(84px, 1fr))` with `gap-1` (4px). */
function pinnedCircleColumns(width: number): number {
  return Math.max(1, Math.floor((width + 4) / (84 + 4)));
}

function chunkPinnedCircles<T>(items: readonly T[], columns: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += columns) rows.push(items.slice(index, index + columns));
  return rows;
}

export function PinnedCircleThreadPanel(props: BotRowProps) {
  const showThreads = useShowThreads();
  const { bot, query, dispatch } = props;
  const visible = useVisibleMessages(bot);
  const last = lastNonReceipt(visible);
  const [creatingProject, setCreatingProject] = useState(false);
  if (!showThreads) return null;
  return (
    <div id={pinnedCircleThreadPanelId(bot.id)} data-sidebar-pinned-circle-thread-list={bot.id} className="mt-1">
      <BotThreadList {...props} activityLabel={liveActivityLabel(last)} query={threadListQuery(bot, query)} />
      <div className="flex items-center gap-1 pl-6">
        <button type="button" aria-label={t("task.newShort")} title={t("task.newShort")} onClick={() => dispatch({ type: "newTask", botId: bot.id })}
          className="inline-flex h-7 items-center gap-1 rounded px-1 text-[13px] font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
          <Plus aria-hidden="true" size={13} />{t("task.newShort")}
        </button>
        <button type="button" aria-label={t("folder.newNamed", { name: bot.name })} title={t("folder.new")} onClick={() => setCreatingProject(true)}
          className="inline-flex h-7 items-center gap-1 rounded px-1 text-[13px] font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
          <FolderPlus aria-hidden="true" size={13} />{t("folder.new")}
        </button>
      </div>
      {creatingProject && <BotProjectDialog bot={bot} onClose={() => setCreatingProject(false)} />}
    </div>
  );
}

export const PinnedBotCircle = memo(function PinnedBotCircle({
  threadPanelHost,
  ...props
}: BotRowProps & { threadPanelHost?: HTMLElement | null }) {
  const { bot, selected, mascotMotion, pendingQueued, reveal, density, query, dispatch, onMenu } = props;
  const showThreads = useShowThreads();
  const visible = useVisibleMessages(bot);
  const [threadsOpen, setThreadsOpen] = useSearchDisclosure(`bot:${bot.id}`, showThreads ? query : "", searchMatchesThreads(query, bot.tasks, bot.projects));
  // nonce, not the thread id: a second jump to the same thread opens it again
  useEffect(() => {
    if (reveal && showThreads) setThreadsOpen(true);
  }, [reveal?.nonce, showThreads]);
  const hasThreadList = botHasThreadList(bot, query);
  const expanded = showThreads && density !== "icons" && threadsOpen && hasThreadList;
  const activityTasks = sidebarBotActivityTasks(bot, pendingQueued);
  const waiting = bot.activity === "waiting-on-you" || activityTasks.some((task) => task.activity === "waiting-on-you");
  const working = !waiting && (Boolean(bot.busy) || activityTasks.some((task) => task.busy || task.activity === "working"));
  const unread = bot.unread || activityTasks.some((task) => task.unread);
  const radius = avatarCropRadius(botAvatarProfile(bot).avatarCrop);
  return (
    <div className="flex w-full min-w-0 flex-col items-center">
      <button
        type="button"
        data-sidebar-bot-row={bot.id}
        aria-current={selected ? "page" : undefined}
        aria-label={`${bot.name}${waiting ? ` · ${t("sidebar.preview.waiting")}` : working ? ` · ${t("chat.activity.working")}` : ""}${unread ? ` · ${t("task.unread")}` : ""}`}
        title={bot.name}
        onClick={() => openBot(dispatch, bot, showThreads)}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
        }}
        className="flex w-full min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-1 text-center outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <span className="relative">
          <span
            className={cn(
              "flex size-16 items-center justify-center overflow-hidden",
              selected && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
            )}
            style={{ borderRadius: radius }}
          >
            <BotAvatar
              bot={bot}
              state={stateForBot({ ...bot, messages: visible })}
              size={64}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
              animated={working || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
            />
          </span>
          {unread && (
            <span className="absolute top-0.5 right-0.5 size-2.5 rounded-full border-2 border-panel bg-accent" aria-label={t("task.unreadMany")} />
          )}
          {working && (
            <span
              data-testid="working-dot"
              className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-panel bg-success"
            />
          )}
          {waiting && (
            <span
              data-testid="waiting-dot"
              role="status"
              aria-label={t("sidebar.preview.waiting")}
              title={t("sidebar.preview.waiting")}
              className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-panel bg-warning"
            />
          )}
        </span>
        <span className="w-full truncate text-center text-[11px] leading-4 text-ink">{bot.name}</span>
      </button>
      {/* Same short slot on every circle, so a chevron on only some bots does not shift the row. */}
      {showThreads && density !== "icons" && <div className="flex h-4 w-full items-center justify-center">
        {hasThreadList && <button
          type="button"
          aria-label={t(threadsOpen ? "task.collapseNamed" : "task.expandNamed", { name: bot.name })}
          aria-expanded={threadsOpen}
          aria-controls={pinnedCircleThreadPanelId(bot.id)}
          onClick={() => setThreadsOpen((open) => !open)}
          className="flex size-4 items-center justify-center rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60"
        ><ChevronRight aria-hidden="true" size={13} className={cn("transition-transform", threadsOpen && "rotate-90")} /></button>}
      </div>}
      {expanded && threadPanelHost ? createPortal(<PinnedCircleThreadPanel {...props} />, threadPanelHost) : null}
    </div>
  );
});

function PinnedCircleGridRow({
  bots,
  columns,
  row,
}: {
  bots: Bot[];
  /** 0 until the grid has been measured: one auto-fill row is enough. */
  columns: number;
  row: (bot: Bot) => BotRowProps;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: columns > 0 ? `repeat(${columns}, minmax(84px, 1fr))` : "repeat(auto-fill, minmax(84px, 1fr))" }}
      >
        {bots.map((bot) => <PinnedBotCircle key={bot.id} {...row(bot)} threadPanelHost={host} />)}
      </div>
      <div ref={setHost} />
    </div>
  );
}

export function PinnedBotRoster({
  bots,
  density,
  circles,
  row,
  listItem: ListItem,
}: {
  bots: Bot[];
  density: SidebarDensity;
  circles: boolean;
  row: (bot: Bot) => BotRowProps;
  listItem: ComponentType<BotRowProps>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const circleLayout = circles && density !== "icons";
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element || !circleLayout) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [circleLayout]);
  if (!circleLayout) {
    return (
      <>
        {bots.map((bot) => <ListItem key={bot.id} {...row(bot)} />)}
      </>
    );
  }
  const columns = width > 0 ? pinnedCircleColumns(width) : 0;
  const circleRows = columns > 0 ? chunkPinnedCircles(bots, columns) : [bots];
  return (
    <div className="px-1 pb-1">
      <div ref={frame} data-sidebar-pinned-circles="" className="flex flex-col gap-1">
        {circleRows.map((rowBots) => (
          <PinnedCircleGridRow key={rowBots.map((bot) => bot.id).join("\0")} bots={rowBots} columns={columns} row={row} />
        ))}
      </div>
    </div>
  );
}
