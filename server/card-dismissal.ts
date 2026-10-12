// Closing a question card with its X, the way both respond endpoints
// (by bot and by thread) answer it. A question stays on the thread after its
// provider request is gone, so it can still be answered late; its X is
// therefore offered only once it has an answer, and a respond that tries to
// close an open one is refused rather than read as that answer.
import { isPersistentQuestionCard, QUESTION_DISMISS_MESSAGE } from "../shared/ask-question.ts";
import type { Message, Store } from "./store.ts";

/** The endpoint's answer to a respond that closes the question card
 * `pending`, or null when the respond is not that (an answer, another kind
 * of card, no card): the endpoint then goes on to deliver it. */
export function dismissQuestionCard(
  store: Pick<Store, "patchMessage">,
  threadId: string,
  pending: Message | undefined,
  body: { dismiss?: unknown; message?: unknown },
): { status: number; body: Record<string, unknown> } | null {
  if (!isPersistentQuestionCard(pending?.card) || !(body.dismiss === true || body.message === QUESTION_DISMISS_MESSAGE)) return null;
  if (!pending?.card) return { status: 404, body: { error: "this question is no longer available" } };
  if (pending.card.answered !== "answer" || pending.card.dismissed) {
    return { status: 409, body: { error: "answer this question before dismissing it" } };
  }
  store.patchMessage(threadId, pending.id, { card: { ...pending.card, dismissed: true } });
  return { status: 200, body: { ok: true, dismissed: true } };
}
