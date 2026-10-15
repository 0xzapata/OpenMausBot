import { useMemo, type KeyboardEvent, type RefObject } from "react";
import { MessageCircleMore, X } from "lucide-react";
import type { CitationAttachment } from "@/lib/citations";
import { removesQuoteChip } from "@/lib/citations-dom";
import type { Attachment } from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";
import { textDirection } from "./ChatMarkdown";

export function quoteLineDirection(text: string, quotes: readonly CitationAttachment[]): "rtl" | "ltr" {
  if (/\p{Letter}/u.test(text)) return textDirection(text);
  return textDirection(quotes[0]?.quote ?? "");
}

const CHIP_TEXT = 80;
const CHIP_TITLE = 2_000;

export function ComposerQuoteChip({ citation, onRemove }: { citation: CitationAttachment; onRemove: () => void }) {
  const flat = citation.quote.replace(/\s+/g, " ").trim();
  const title = [
    citation.quote.length > CHIP_TITLE ? `${citation.quote.slice(0, CHIP_TITLE)}…` : citation.quote,
    citation.comment ? `\n\n${citation.comment}` : "",
  ].join("");
  return (
    <span
      data-quote-chip
      title={title}
      className="group/quote inline-flex h-7 min-w-0 max-w-[min(12rem,70%)] shrink items-center gap-1.5 rounded-lg px-1.5 text-[14px] text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-within:bg-raised"
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <MessageCircleMore size={15} aria-hidden="true" className="transition-opacity group-focus-within/quote:opacity-0 group-hover/quote:opacity-0 touch:opacity-0" />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("citation.remove", { quote: flat.slice(0, 60) })}
          className="absolute inset-[-2px] flex items-center justify-center rounded-full text-ink opacity-0 transition-opacity hover:bg-control focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 group-hover/quote:opacity-100 touch:opacity-100"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </span>
      <span dir="auto" className="min-w-0 truncate">
        {"\u201C"}{flat.length > CHIP_TEXT ? flat.slice(0, CHIP_TEXT) : flat}
      </span>
    </span>
  );
}

export function useComposerQuotes({ attachments, text, removeAttachment, inputRef }: {
  attachments: readonly Attachment[];
  text: string;
  removeAttachment: (id: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const quotes = useMemo(
    () => attachments.filter((attachment): attachment is CitationAttachment => attachment.kind === "citation"),
    [attachments],
  );
  const removeQuote = (id: string) => {
    removeAttachment(id);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const takesKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const last = quotes.at(-1);
    if (!last || !removesQuoteChip(
      { key: e.key, isComposing: e.nativeEvent.isComposing },
      { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd },
    )) return false;
    e.preventDefault();
    e.stopPropagation();
    removeQuote(last.id);
    return true;
  };
  if (quotes.length === 0) return { hasQuotes: false, leading: undefined, leadingDir: undefined, takesKey };
  return {
    hasQuotes: true,
    leading: quotes.map((quote) => <ComposerQuoteChip key={quote.id} citation={quote} onRemove={() => removeQuote(quote.id)} />),
    leadingDir: quoteLineDirection(text, quotes),
    takesKey,
  };
}
