// Chat links opened from outside the app (#2383): openmausbot://thread/… and
// openmausbot://bot/…, handed over by the desktop shell. Subscribed from the
// always-mounted shell, not a view: the sidebar is not mounted on every page,
// and a link must work from any of them.
import { useEffect, useState } from "react";
import { openChatLink } from "@/components/ThreadRefs";
import type { Action, AppState } from "@/state/store";

export function useExternalChatLinks(state: AppState, dispatch: (action: Action) => void): void {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => window.ogb?.onChatLink?.(setLink), []);
  // One that arrives at launch waits until the bots have loaded, so it can
  // find its chat; a newer link replaces one still waiting.
  useEffect(() => {
    if (!link || !state.hydrated) return;
    setLink(null);
    // Settings is a modal over the chat: the link's chat, or its notice,
    // would open behind it. Closing it loses nothing; a backdrop click does it.
    if (state.appSettingsOpen) dispatch({ type: "toggleAppSettings", open: false });
    openChatLink(dispatch, link, state);
  }, [link, state, dispatch]);
}
