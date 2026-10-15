import type { KeyboardEvent } from "react";
import { CalendarClock, Database, FolderOpen, Globe, Monitor, Smartphone, type LucideIcon } from "lucide-react";
import type { ComputerPanelView } from "@/lib/computer-panel-view";
import type { LocaleKey } from "@/locales";

export const PANEL_TABS: Record<ComputerPanelView, { Icon: LucideIcon; label: LocaleKey; tour?: string }> = {
  computer: { Icon: Monitor, label: "computer.tab.computer" },
  routines: { Icon: CalendarClock, label: "computer.tab.routines" },
  android: { Icon: Smartphone, label: "computer.tab.android" },
  browser: { Icon: Globe, label: "computer.tab.browser", tour: "computer-browser" },
  data: { Icon: Database, label: "computer.tab.data", tour: "computer-data" },
  files: { Icon: FolderOpen, label: "computer.tab.files" },
};

export const TAB_PANEL_FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";

const tabId = (view: ComputerPanelView) => `computer-panel-tabs-tab-${view}`;
const panelId = (view: ComputerPanelView) => `computer-panel-tabs-panel-${view}`;

export const panelTabProps = (view: ComputerPanelView, selected: boolean) => ({
  id: tabId(view),
  role: "tab",
  "aria-selected": selected,
  "aria-controls": panelId(view),
  tabIndex: selected ? 0 : -1,
}) as const;

export const tabPanelProps = (view: ComputerPanelView) => ({
  role: "tabpanel",
  id: panelId(view),
  "aria-labelledby": tabId(view),
  tabIndex: 0,
}) as const;

export function moveBetweenTabs(
  event: KeyboardEvent<HTMLElement>,
  tabs: readonly ComputerPanelView[],
  select: (view: ComputerPanelView) => void,
): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const at = Math.max(0, tabs.findIndex((view) => tabId(view) === (event.target as HTMLElement).id));
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  const next = event.key === "Home" ? tabs[0]
    : event.key === "End" ? tabs[tabs.length - 1]
    : step ? tabs[(at + step + tabs.length) % tabs.length]
    : undefined;
  if (!next) return;
  event.preventDefault();
  select(next);
  document.getElementById(tabId(next))?.focus();
}
