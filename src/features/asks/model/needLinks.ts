// A question from any project, answered inside the Chief of Staff's reply (Ash's round 3 pick, 13 Nov: questions
// answered where they are, so he never leaves the one chat). The reply links a Needs you item as
// `[Which take?](hivra://local/need/<key>)` and the chat draws that link as the item's own answer card
// (asks/ui/InlineNeed.tsx). The Chief of Staff learns each open item's link from a note beside Ash's message.
import type { NeedsItem } from "../../needs/model/needsYou";

const PREFIX = "hivra://local/need/";
const KEY_MAX = 300;
const NOTE_ITEMS = 12;

/** The link a reply uses for one Needs you item. */
export function needLink(key: string): string {
  return `${PREFIX}${encodeURIComponent(key)}`;
}

/** The item key a link names, or undefined when it isn't a need link. */
export function needKeyOf(href: string | undefined): string | undefined {
  if (!href || href.length > PREFIX.length + KEY_MAX * 3) return undefined;
  if (href.slice(0, PREFIX.length).toLowerCase() !== PREFIX) return undefined;
  const raw = href.slice(PREFIX.length);
  if (!raw || /[/?#\s]/.test(raw)) return undefined;
  try {
    const key = decodeURIComponent(raw);
    return key.trim() && key.length <= KEY_MAX && !/[\u0000-\u001f\u007f]/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

/** The open item a link names: its own key, else a decision's key (a model may give the shorter one). */
export function findNeed<T extends Pick<NeedsItem, "key" | "decisionKey">>(items: readonly T[], key: string): T | undefined {
  return items.find((item) => item.key === key) ?? items.find((item) => !!item.decisionKey && item.decisionKey === key);
}

/** What changes the note: the open items and their words. */
export function needLinksKey(items: readonly Pick<NeedsItem, "key" | "sentence">[]): string {
  return items.map((item) => `${item.key}\n${item.sentence}`).join("\n\n");
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
}

/**
 * The note beside Ash's message in the one chat: every open Needs you item with its link, so a reply asks about one
 * with the card he answers from. Undefined when nothing is open.
 */
export function needLinksNote(
  items: readonly Pick<NeedsItem, "key" | "sentence" | "who" | "choices">[],
  where: (item: Pick<NeedsItem, "key">) => string | undefined = () => undefined,
): string | undefined {
  if (!items.length) return undefined;
  const shown = items.slice(0, NOTE_ITEMS);
  const lines = shown.map((item) => {
    const place = [where(item), item.who].filter(Boolean).join(" · ");
    const answers = item.choices?.length ? ` (answers: ${item.choices.map(flat).join(" / ")})` : "";
    return `- [${flat(item.sentence)}](${needLink(item.key)})${place ? ` · ${place}` : ""}${answers}`;
  });
  const more = items.length - shown.length;
  return [
    "<needs_you_links>",
    "What is waiting on Ash right now. When your reply asks him about one of these, put its link on a line of its own, exactly as given: the chat shows it as that question's own card, with every answer and a box for his words, and he answers there. Don't list the answers again in your words, and don't link anything that isn't on this list.",
    ...lines,
    ...(more > 0 ? [`- and ${more} more in Needs you`] : []),
    "</needs_you_links>",
  ].join("\n");
}
