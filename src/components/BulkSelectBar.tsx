import { useCallback, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { archivedIds, clearSelection, clickRow, isTickable, olderThanIds, selectAll, summarizeDelete, type SelectableRow } from "@/lib/bulk-select";
import type { BulkDeleteResult } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";

const OLDER_DAYS = 30;

const chip = "rounded-full border border-hairline/50 px-2.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40";

/** Select mode state for one thread list. Each render hands `forRows` the
 * rows the list shows, in display order: shift-click ranges and the quick
 * filters then only touch rows the person can see, and ids that vanish or
 * start running drop out of the selection. */
export function useBulkSelect() {
  const [active, setActive] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const shown = useRef<readonly SelectableRow[]>([]);
  const toggle = useCallback((task: { threadId: string }, shiftKey: boolean) => {
    // Read the anchor now: the updater below runs later, after it moves on.
    const from = anchor.current;
    anchor.current = task.threadId;
    setPicked((previous) => clickRow(previous, shown.current, from, task.threadId, shiftKey));
  }, []);
  const start = useCallback(() => setActive(true), []);
  const finish = useCallback(() => { setActive(false); setPicked(new Set()); anchor.current = null; }, []);
  const forRows = (rows: readonly SelectableRow[]): ReadonlySet<string> => {
    shown.current = rows;
    return new Set(rows.filter((row) => picked.has(row.threadId) && isTickable(row)).map((row) => row.threadId));
  };
  return { active, start, finish, forRows, setSelected: setPicked, toggle };
}

/** The quick filters at the top of a thread list in Select mode. */
export function BulkSelectFilters({ rows, selected, now, onChange, onDone }: {
  rows: readonly SelectableRow[];
  selected: ReadonlySet<string>;
  now: number;
  onChange: (next: Set<string>) => void;
  onDone: () => void;
}) {
  const add = (ids: string[]) => onChange(new Set([...selected, ...ids]));
  return <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5 pt-1" role="group" aria-label={t("task.bulk.select")}>
    <button type="button" className={chip} onClick={() => onChange(selectAll(rows))}>{t("task.bulk.selectAll")}</button>
    <button type="button" className={chip} onClick={() => add(olderThanIds(rows, OLDER_DAYS, now))}>{t("task.bulk.older", { days: OLDER_DAYS })}</button>
    <button type="button" className={chip} onClick={() => add(archivedIds(rows))}>{t("task.bulk.archived")}</button>
    <button type="button" className={chip} disabled={selected.size === 0} onClick={() => onChange(clearSelection())}>{t("task.bulk.clear")}</button>
    <button type="button" onClick={onDone} className="ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:underline">{t("task.bulk.done")}</button>
  </div>;
}

/** The sticky bar with the count, Cancel, and Delete, plus the one
 * confirmation and one result line for the whole batch. */
export function BulkSelectBar({ rows, selected, maxDeletable, freshConversation, onChange, onDelete }: {
  rows: readonly SelectableRow[];
  selected: ReadonlySet<string>;
  /** A channel must keep one thread; omit for no limit. */
  maxDeletable?: number;
  /** Deleting every thread of a bot starts a new empty conversation. */
  freshConversation: boolean;
  onChange: (next: Set<string>) => void;
  onDelete: (threadIds: string[], onSettled: (result: BulkDeleteResult) => void) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const count = selected.size;
  const overLimit = maxDeletable !== undefined && count > maxDeletable;
  const pinned = rows.filter((row) => selected.has(row.threadId) && row.pinned === true).length;
  const everything = rows.length > 0 && rows.every((row) => selected.has(row.threadId));
  const body = [
    t("task.bulk.confirmBody"),
    pinned > 0 ? t("task.bulk.pinnedNote", { count: pinned }) : null,
    freshConversation && everything ? t("task.bulk.freshNote") : null,
  ].filter(Boolean).join(" ");
  const run = () => {
    const ids = [...selected];
    setPending(true);
    setResult(null);
    onDelete(ids, (outcome) => {
      const done = summarizeDelete(outcome.responses);
      const gone = new Set(outcome.responses.flatMap((response) => response.deleted));
      const lines = [
        t("task.bulk.result", { count: done.deleted }),
        done.busy > 0 ? t("task.bulk.resultBusy", { count: done.busy }) : null,
        done.missing > 0 ? t("task.bulk.resultMissing", { count: done.missing }) : null,
        outcome.error ? t("task.bulk.resultError", { message: outcome.error }) : null,
      ].filter(Boolean);
      onChange(new Set([...selected].filter((id) => !gone.has(id))));
      setResult(lines.join(" "));
      setPending(false);
      setConfirming(false);
    });
  };
  return <div className="sticky bottom-0 z-10 -mx-1 border-t border-hairline/40 bg-panel px-2 py-1.5">
    <span role="status" className="block text-[11px] text-ink-secondary">
      {result ?? (overLimit ? t("task.bulk.channelLimit") : "")}
    </span>
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{t("task.bulk.selected", { count })}</span>
      <button type="button" disabled={count === 0 || pending} onClick={() => onChange(clearSelection())}
        className="rounded-md px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">{t("task.bulk.cancel")}</button>
      <button type="button" disabled={count === 0 || overLimit || pending} aria-busy={pending || undefined} onClick={() => setConfirming(true)}
        className="rounded-md bg-danger px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40">
        {pending ? t("task.bulk.deleting") : t("task.bulk.delete", { count })}
      </button>
    </div>
    <ConfirmDialog open={confirming} title={t("task.bulk.confirmTitle", { count })} body={body} confirmLabel={t("task.bulk.delete", { count })}
      pending={pending} onCancel={() => { if (!pending) setConfirming(false); }} onConfirm={run} />
  </div>;
}
