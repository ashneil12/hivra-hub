import { ContextMeter } from "../../sessions/ui/ContextMeter";
import { ModelLineRow, TurnStopButton, showsStop } from "./TurnStop";
import type { ContextUsage } from "../../sessions/model/contextUsage";
import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isImeComposition } from "../../../shared/lib/keyboard";
import { ArrowUp, File as FileIcon, ImagePlus, Plus, SmilePlus } from "../../../shared/ui/icons";
import { AttachmentChip } from "../../sessions/ui/AttachmentChip";
import type { Attachment } from "../../sessions/model/session";
import {
  attachmentsFromFiles,
  filesFromClipboard,
  mergeAttachments,
  pickAttachments,
  revokeAttachment,
  type AttachPick,
} from "../../sessions/model/attachments";
import {
  getComposerDraft,
  setComposerDraft,
} from "../../sessions/model/draftCache";
import { useFileDrop } from "../../sessions/hooks/useFileDrop";
import { resizeComposer } from "../../sessions/model/composerResize";
import { useComposerAutocorrect } from "../../settings/model/displayPrefs";
import {
  consumeQuoteRequest,
  type QuoteRequest,
} from "../../sessions/model/quoteDraft";
import {
  stripHiddenCharacters,
  stripHiddenText,
} from "../../sessions/model/hiddenText";
import {
  isLargePaste,
  isPasteKey,
  largePasteContents,
} from "../../sessions/model/largePaste";

// Loaded on first open, with its emoji data, so neither weighs on startup.
const EmojiPickerPopover = lazy(() =>
  import("../../../shared/ui/EmojiPicker").then((module) => ({
    default: module.EmojiPickerPopover,
  })),
);

const DROP_STATE = { current: { attachmentsSupported: true, remote: false } };

/** Tallest the field grows before it scrolls, in px. */
const MAX_HEIGHT = 160;
/** The quiet buttons under the input: a glyph that gains a backdrop on hover. */
const TOOL_BUTTON =
  "grid size-6.5 shrink-0 place-items-center rounded-md text-content/55 transition-colors hover:bg-content/8 hover:text-content disabled:opacity-50";
const INPUT_COLUMNS = "grid-cols-[1.625rem_minmax(0,1fr)_1.625rem]";
const FIELD_CLASSES =
  "scrollbar-none block min-w-0 w-full resize-none bg-transparent py-1 text-[13px] leading-4.5 text-content outline-none placeholder:text-content/35";

type Props = {
  sessionId: string;
  name: string;
  enabled?: boolean;
  showContext?: boolean;
  context?: ContextUsage;
  contextEmpty?: boolean;
  focusToken?: number;
  quoteRequest?: QuoteRequest;
  onQuoteRequestConsumed?: (id: number) => void;
  onDraftChange?: (text: string) => void;
  /** Returns false when the message wasn't taken, so the draft stays. */
  onSubmit: (
    text: string,
    attachments: Attachment[],
  ) => boolean | void | Promise<boolean | void>;
  onFocus?: () => void;
  /**
   * Sits under the input on the right, like the model and its effort, with
   * attach across from it. Without any, attach and send share the field's
   * line, as in the floating chat.
   */
  controls?: ReactNode;
  /** Sits beside attach and emoji, on the left under the input. */
  tools?: ReactNode;
  /** The model line above the box (port map idea 2: UniiChat's pick line): a hairline, then the model as small text. */
  modelLine?: ReactNode;
  /** This chat's turn is running: an empty box's send becomes Stop. */
  busy?: boolean;
  /** Stop this chat's own turn (never the work it handed out). */
  onStop?: () => void;
};

export { showsStop };

/**
 * A messaging app's input for the Mono: attach, type, send, whether or not
 * it is mid-reply; Escape stops a reply. Files dropped anywhere on the chat
 * attach here. Attach sits under the input, with any `controls` (the model
 * and its effort) across from it, or beside the field when there are none;
 * permissions and checkout live in the details panel.
 */
export function MonoComposer({
  sessionId,
  name,
  enabled = true,
  focusToken,
  quoteRequest,
  onQuoteRequestConsumed,
  onDraftChange,
  onSubmit,
  onFocus,
  controls,
  tools,
  modelLine,
  busy = false,
  onStop,
  showContext = false,
  context,
  contextEmpty = false,
}: Props) {
  const [text, setText] = useState(() => getComposerDraft(sessionId) ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const autocorrect = useComposerAutocorrect();
  const textRef = useRef(text);
  const attachmentsRef = useRef(attachments);
  const consumedQuote = useRef<number | null>(null);
  const readGeneration = useRef(0);
  const pendingReadsRef = useRef(0);
  const [pendingReads, setPendingReads] = useState(0);
  const [multiline, setMultiline] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const inlineMeasure = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  /** A send or paste where hidden characters were removed: news, not a failure. */
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const submittingRef = useRef(false);
  /** The paste shortcut was held at the last keydown, since a paste event carries no modifier keys. */
  const inlinePasteRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const ready =
    enabled &&
    !submitting &&
    pendingReads === 0 &&
    (text.trim().length > 0 || attachments.length > 0);
  const stop = showsStop({ enabled, busy, text, attachments: attachments.length, canStop: !!onStop });
  const inline = !controls && !modelLine;
  // Attachments sit above the field like a second line of text, so an inline
  // field moves above the buttons for them too.
  const stacked = inline && (multiline || attachments.length > 0);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const measure = inlineMeasure.current;
    const fit = () => {
      if (!el.clientWidth) return;
      if (measure?.clientWidth) {
        // Always measure at the inline width. Expanding the field above the
        // buttons must not make it collapse again just because it is wider.
        const style = getComputedStyle(measure);
        const singleLineHeight =
          Number.parseFloat(style.lineHeight) +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom);
        setMultiline(measure.scrollHeight > singleLineHeight + 1);
      }
      // Holds the input's height while measuring, as sessions do, so the
      // transcript above never grows for a moment and loses its bottom pin.
      resizeComposer(el, MAX_HEIGHT);
      el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    };
    fit();
    // An empty field stays one line at any width, so once measured, resizing
    // the panes beside it need not measure it every frame.
    const sized = measure ?? el;
    if (!text && sized.clientWidth) return;
    let width = sized.clientWidth;
    const observer = new ResizeObserver(() => {
      // Only a new width can rewrap the text; growing taller is our own doing.
      if (sized.clientWidth === width) return;
      width = sized.clientWidth;
      fit();
    });
    observer.observe(sized);
    return () => observer.disconnect();
  }, [text, multiline, stacked]);

  useLayoutEffect(() => {
    if (focusToken != null) field.current?.focus();
  }, [focusToken]);

  const update = (next: string) => {
    textRef.current = next;
    setText(next);
    setComposerDraft(sessionId, next);
    onDraftChange?.(next);
  };
  const emojiButton = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Where the pick goes: the field's selection when the picker opened.
  const emojiSelection = useRef<[number, number] | null>(null);
  const toggleEmoji = () => {
    if (emojiOpen) return setEmojiOpen(false);
    const el = field.current;
    emojiSelection.current = el ? [el.selectionStart, el.selectionEnd] : null;
    setEmojiOpen(true);
  };
  const insertEmoji = (emoji: string) => {
    const current = textRef.current;
    const [start, end] = emojiSelection.current ?? [
      current.length,
      current.length,
    ];
    update(current.slice(0, start) + emoji + current.slice(end));
    setEmojiOpen(false);
    const caret = start + emoji.length;
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(caret, caret);
    });
  };
  useLayoutEffect(() => {
    const next = consumeQuoteRequest(
      textRef.current,
      consumedQuote.current,
      quoteRequest,
    );
    consumedQuote.current = next.consumedId;
    if (next.changed) {
      update(next.draft);
      if (enabled) field.current?.focus();
    }
    if (next.consumedId != null) onQuoteRequestConsumed?.(next.consumedId);
  }, [quoteRequest, onQuoteRequestConsumed, enabled]);
  useLayoutEffect(
    () => () => {
      readGeneration.current++;
      for (const file of attachmentsRef.current) revokeAttachment(file);
    },
    [],
  );
  const add = (incoming: Attachment[]) => {
    if (incoming.length === 0) return;
    const next = mergeAttachments(attachmentsRef.current, incoming);
    attachmentsRef.current = next;
    setAttachments(next);
  };
  const readAttachments = useCallback(
    (read: () => Promise<Attachment[]>, dropped = false) => {
      if (submittingRef.current) return;
      const generation = readGeneration.current;
      pendingReadsRef.current++;
      setPendingReads(pendingReadsRef.current);
      setDropError(null);
      Promise.resolve()
        .then(read)
        .then((incoming) => {
          if (generation !== readGeneration.current) {
            incoming.forEach(revokeAttachment);
            return;
          }
          if (incoming.length === 0) {
            if (dropped)
              setDropError(
                "Nothing to attach from that drop — the file may have been moved, renamed, or deleted.",
              );
            return;
          }
          add(incoming);
        })
        .catch((reason: unknown) => {
          if (generation === readGeneration.current)
            setDropError(
              reason instanceof Error ? reason.message : String(reason),
            );
        })
        .finally(() => {
          pendingReadsRef.current--;
          if (generation === readGeneration.current)
            setPendingReads(pendingReadsRef.current);
        });
    },
    [],
  );
  const readDropped = useCallback(
    (read: () => Promise<Attachment[]>) => {
      readAttachments(read, true);
    },
    [readAttachments],
  );
  const fileDrag = useFileDrop({
    anchor: box,
    enabled: enabled && !submitting,
    state: DROP_STATE,
    read: readDropped,
    onError: setDropError,
  });
  const send = () => {
    // An empty box while the turn runs: Enter or the button stops it (UniiChat View.ts view_act "Send").
    if (
      showsStop({
        enabled,
        busy,
        text: textRef.current,
        attachments: attachmentsRef.current.length,
        canStop: !!onStop,
      })
    ) {
      onStop?.();
      return;
    }
    if (!enabled || submittingRef.current || pendingReadsRef.current > 0)
      return;
    // WP-94: hidden characters never reach the agent, and the composer says what it removed (hiddenText.ts).
    const hidden = stripHiddenText(textRef.current);
    if (hidden.removed > 0) {
      update(hidden.text);
      if (!hidden.text && !attachmentsRef.current.length) {
        setDropNotice(null);
        setDropError("That message had only hidden characters, so it was not sent.");
        return;
      }
      setDropNotice(
        `Removed ${hidden.removed} hidden ${hidden.removed === 1 ? "character" : "characters"} from your message.`,
      );
    } else setDropNotice(null);
    const message = hidden.text;
    const draft = hidden.text;
    const files = attachmentsRef.current;
    if (!message && !files.length) return;
    const generation = readGeneration.current;
    const clear = (accepted: boolean | void) => {
      if (accepted === false) return;
      if (generation !== readGeneration.current) {
        if (getComposerDraft(sessionId) === draft)
          setComposerDraft(sessionId, "");
        return;
      }
      update("");
      attachmentsRef.current = [];
      setAttachments([]);
      setDropError(null);
    };
    const result = onSubmit(message, files);
    if (result instanceof Promise) {
      submittingRef.current = true;
      setSubmitting(true);
      void result
        .then(clear)
        .catch((reason: unknown) => {
          if (generation === readGeneration.current)
            setDropError(
              reason instanceof Error ? reason.message : String(reason),
            );
        })
        .finally(() => {
          submittingRef.current = false;
          if (generation === readGeneration.current) setSubmitting(false);
        });
    } else clear(result);
  };

  // + opens a small menu (Ash, 15 Oct: "The plus sign, what is it that you
  // can attach anything? ... there's a different variety of media that you
  // might want to use"): photos and videos, or any file; pasting or dropping
  // works for anything too.
  const [attachMenu, setAttachMenu] = useState(false);
  const attachWrap = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!attachMenu) return;
    const down = (event: MouseEvent) => {
      if (!attachWrap.current?.contains(event.target as Node))
        setAttachMenu(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAttachMenu(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [attachMenu]);
  const pick = (kind: AttachPick) => {
    setAttachMenu(false);
    readAttachments(() => pickAttachments(kind));
  };
  const ATTACH_ITEM =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-content hover:bg-content/8";
  // `tool` sizes the plus to match the emoji face beside it: its cross fills
  // 14 of the glyph's 24 units against the face's 21, so it is drawn larger,
  // with a thinner stroke so both lines render about 1px wide.
  const attachButton = (className: string, tool = false, placement = "") => (
    <span ref={attachWrap} className={`relative ${placement}`}>
      <button
        type="button"
        title="Attach photos or files"
        aria-label="Attach files"
        aria-haspopup="menu"
        aria-expanded={attachMenu}
        disabled={!enabled || submitting}
        onClick={() => setAttachMenu((open) => !open)}
        className={className}
      >
        <Plus
          className={tool ? "size-4.25" : "size-3.5"}
          strokeWidth={tool ? 1.5 : 1.75}
        />
      </button>
      {attachMenu ? (
        <div
          role="menu"
          data-attach-menu
          className="absolute bottom-full left-0 z-30 mb-1.5 w-[220px] rounded-lg border border-stroke popover-glass p-1 shadow-2xl"
        >
          <button type="button" role="menuitem" data-attach-pick="media" onClick={() => pick("media")} className={ATTACH_ITEM}>
            <ImagePlus className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
            Photo or image
          </button>
          <button type="button" role="menuitem" data-attach-pick="file" onClick={() => pick("file")} className={ATTACH_ITEM}>
            <FileIcon className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
            File
          </button>
          <p className="px-2 pb-1 pt-1 text-[11px] leading-4 text-content/55">
            You can also paste or drop anything here.
          </p>
        </div>
      ) : null}
    </span>
  );
  const input = (className: string) => (
    <textarea
      ref={field}
      rows={1}
      aria-label={`Message ${name}`}
      placeholder={`Message ${name}`}
      spellCheck={autocorrect}
      autoCorrect={autocorrect ? "on" : "off"}
      disabled={!enabled || submitting}
      value={text}
      onFocus={onFocus}
      onChange={(event) => update(event.target.value)}
      onKeyDown={(event) => {
        inlinePasteRef.current =
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          isPasteKey(event.nativeEvent);
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          isImeComposition(event.nativeEvent)
        ) {
          return;
        }
        event.preventDefault();
        send();
      }}
      onPaste={(event) => {
        const files = filesFromClipboard(event.clipboardData);
        if (files.length === 0) {
          const plain = event.clipboardData?.getData("text/plain") ?? "";
          const paste = plain ? stripHiddenCharacters(plain) : null;
          // WP-94: a big paste becomes a text file instead of flooding the prompt; Shift keeps it inline
          // (largePaste.ts). A paste of only hidden characters falls through to the notice below.
          if (
            paste?.text &&
            isLargePaste(paste.text) &&
            !inlinePasteRef.current
          ) {
            event.preventDefault();
            readAttachments(async () => {
              let saved: Attachment[];
              try {
                saved = await attachmentsFromFiles([
                  largePasteContents(paste.text),
                ]);
              } catch {
                saved = [];
              }
              if (saved.length) {
                setDropNotice(
                  `That paste was large, so it became the file ${saved[0].name}. Hold Shift while pasting to keep it inline.`,
                );
              } else {
                setDropError(
                  "That paste was too big to send as text, and it could not be saved as a file. Try again.",
                );
              }
              return saved;
            });
            return;
          }
          // WP-94: a paste keeps its visible text and loses every hidden character.
          if (!paste || paste.removed === 0) return;
          event.preventDefault();
          if (paste.text) {
            // At the caret, as a paste goes, not at the end of whatever comes after it.
            const start = event.currentTarget.selectionStart ?? textRef.current.length;
            const end = event.currentTarget.selectionEnd ?? start;
            const next =
              textRef.current.slice(0, start) +
              paste.text +
              textRef.current.slice(end);
            update(next);
            const caret = start + paste.text.length;
            requestAnimationFrame(() =>
              event.currentTarget.setSelectionRange(caret, caret),
            );
          }
          if (paste.text) {
            setDropNotice(
              `Removed ${paste.removed} hidden ${paste.removed === 1 ? "character" : "characters"} from the paste.`,
            );
          } else {
            setDropNotice(null);
            setDropError(
              "That paste had only hidden characters, so nothing was pasted.",
            );
          }
          return;
        }
        event.preventDefault();
        readAttachments(() => attachmentsFromFiles(files));
      }}
      className={`${FIELD_CLASSES} ${className}`}
    />
  );
  const sendButton = (className: string) =>
    stop ? (
      // The same button in the same spot and size (TurnStop.tsx); a submit, so the form's send() stops the turn.
      <TurnStopButton type="submit" className={className} />
    ) : (
      <button
        type="submit"
        aria-label="Send"
        title={pendingReads ? "Reading attachments…" : "Send"}
        disabled={!ready}
        className={`primary-action grid size-6.5 place-items-center rounded-md transition-[background-color,color,transform] duration-150 active:scale-90 disabled:cursor-default ${className}`}
      >
        <ArrowUp className="size-3.5" strokeWidth={2} />
      </button>
    );

  return (
    <form
      className="w-full shrink-0 p-1.5 pt-0 font-sans"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {modelLine ? <ModelLineRow>{modelLine}</ModelLineRow> : null}
      <div
        ref={box}
        className={`agent-chat-composer relative rounded-lg border bg-content/3 backdrop-blur-sm ${fileDrag ? "border-accent/60" : "border-content/10 has-focus:border-content/20"}`}
      >
        {fileDrag ? (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-lg bg-accent/8 text-[12px] text-content/70">
            Drop files to attach
          </div>
        ) : null}
        {dropError ? (
          <p role="alert" className="px-3 pt-2 text-xs text-red-400">
            {dropError}
          </p>
        ) : dropNotice ? (
          <p data-composer-notice className="px-3 pt-2 text-xs text-content/55">
            {dropNotice}
          </p>
        ) : null}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2">
            {attachments.map((file) => (
              <AttachmentChip
                key={file.id}
                attachment={file}
                onRemove={() => {
                  if (submittingRef.current) return;
                  revokeAttachment(file);
                  const next = attachmentsRef.current.filter(
                    (item) => item.id !== file.id,
                  );
                  attachmentsRef.current = next;
                  setAttachments(next);
                }}
              />
            ))}
          </div>
        ) : null}
        {inline ? (
          <div
            data-layout={stacked ? "multiline" : "inline"}
            className={`relative grid min-h-9 ${INPUT_COLUMNS} items-center gap-x-1.5 p-1 ${stacked ? "gap-y-1" : ""}`}
          >
            <div
              aria-hidden="true"
              className={`pointer-events-none invisible absolute inset-x-1 top-1 grid ${INPUT_COLUMNS} gap-x-1.5`}
            >
              <textarea
                ref={inlineMeasure}
                tabIndex={-1}
                readOnly
                rows={1}
                value={text}
                className={`${FIELD_CLASSES} col-start-2 h-0 overflow-hidden`}
              />
            </div>
            {attachButton(
              "grid size-6.5 place-items-center rounded-md bg-content/8 text-content/55 hover:bg-content/12 hover:text-content",
              false,
              `col-start-1 grid ${stacked ? "row-start-2" : "row-start-1"}`,
            )}
            {input(
              `row-start-1 ${stacked ? "col-span-3 col-start-1 px-1.5" : "col-start-2"}`,
            )}
            {sendButton(
              `col-start-3 ${stacked ? "row-start-2" : "row-start-1"}`,
            )}
          </div>
        ) : (
          // Even padding centers send beside one line, and keeps it at the
          // bottom as the text grows.
          <div className="flex items-end gap-1.5 p-1.25">
            {input("flex-1 self-center px-1.5")}
            {sendButton("shrink-0")}
          </div>
        )}
      </div>
      {inline && showContext ? <div className="flex justify-end px-1.5 pt-1"><ContextMeter usage={context} empty={contextEmpty} /></div> : null}
      {inline ? null : (
        // The right inset matches the box's border and padding, so the last
        // control lines up under send. A container, so the tools and controls
        // passed in can compact themselves when the chat is narrow.
        <div className="@container flex min-w-0 items-center gap-0.5 pt-1 pl-1 pr-1.5">
          {attachButton(TOOL_BUTTON, true)}
          <button
            ref={emojiButton}
            type="button"
            title="Emoji"
            aria-label="Add emoji"
            aria-expanded={emojiOpen}
            disabled={!enabled || submitting}
            onClick={toggleEmoji}
            className={`${TOOL_BUTTON} ${emojiOpen ? "bg-content/8 text-content" : ""}`}
          >
            <SmilePlus className="size-3.25" strokeWidth={2} />
          </button>
          {emojiOpen ? (
            <Suspense fallback={null}>
              <EmojiPickerPopover
                anchor={emojiButton}
                onPick={insertEmoji}
                onDismiss={() => {
                  setEmojiOpen(false);
                  field.current?.focus();
                }}
              />
            </Suspense>
          ) : null}
          {tools}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {controls}
            {showContext ? <ContextMeter usage={context} empty={contextEmpty} /> : null}
          </div>
        </div>
      )}
    </form>
  );
}
