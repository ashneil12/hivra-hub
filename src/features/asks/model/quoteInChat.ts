// Quote a Needs you, You asked or Working row into the chat (Ash, 13 Nov: "everything here, you should be able to like
// quote it in the chat ... whether it's working, needs you, or you asked"). The row goes into the composer as a quote,
// not sent, so he adds his words under it and the Chief of Staff reads exactly which item he means.
import type { NeedsItem } from "../../needs/model/needsYou";
import { NEED_KIND_LABEL } from "../../needs/model/needContext";
import { typeIntoChat } from "../../monos/model/monoPrefill";

/** One quote line: what list it came from, where it belongs, then the item itself. */
function line(parts: (string | undefined | false)[], text: string, tail?: string): string {
  const head = parts.filter((part): part is string => !!part && !!part.trim()).join(" · ");
  const body = text.replace(/\s+/g, " ").trim();
  return `${head}: ${body}${tail ? ` (${tail.replace(/\s+/g, " ").trim()})` : ""}`;
}

/** "Needs you · Question · EXO · EXO lead: Which take for the boss music? (Suggested: Take A: drums first)" */
export function quoteNeed(item: Pick<NeedsItem, "kind" | "sentence" | "who" | "suggested">, project?: string): string {
  return line(["Needs you", NEED_KIND_LABEL[item.kind], project, item.who], item.sentence, item.suggested ? `Suggested: ${item.suggested}` : undefined);
}

/** "You asked: Fix the Safari export button (Open · said 2 times)" */
export function quoteAsked(ask: { title: string; status: string; note?: string; said?: number; words?: string; id?: string; chatId?: string; blockId?: string }): string {
  const tail = [ask.status, ask.said && ask.said > 1 ? `said ${ask.said} times` : "", ask.note ?? ""].filter((part) => part.trim()).join(" · ");
  const quote = line(["You asked"], ask.words ?? ask.title, tail || undefined);
  return ask.id && ask.chatId && ask.blockId ? `${quote}\nSource: ask ${ask.id}; chat ${ask.chatId}; message ${ask.blockId}` : quote;
}

/** "Working · EXO · EXO lead: Light the Area 3 boss arena (Working)" */
export function quoteJob(job: { title: string; project?: string; lead?: string; state?: string }): string {
  return line(["Working", job.project, job.lead], job.title, job.state);
}

/** The quote as the composer takes it: each line marked as quoted. */
export function asQuote(text: string): string {
  const flat = text.replace(/\r\n?/g, "\n").trim();
  if (!flat) return "";
  return flat
    .split("\n")
    .map((part) => (part ? `> ${part}` : ">"))
    .join("\n");
}

/** Put the quote in that chat's composer, not sent. Nothing when there is no chat or no words. */
export function quoteInChat(sessionId: string | undefined, text: string): boolean {
  const quote = asQuote(text);
  if (!sessionId || !quote) return false;
  typeIntoChat(sessionId, quote);
  return true;
}
