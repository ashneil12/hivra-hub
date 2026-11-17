// What this app puts ahead of the person's message (`monoTurn`: who the agent is and what it knows) is not the
// person's words. T3 keeps such text apart from a message as a context record: the message holds a short link to it,
// the provider is given the record's text after the message, and no client shows it as something the person wrote.

const OPEN = "<monocode_context>\n";
const CLOSE = "\n</monocode_context>";
const KIND = "dropwave-context";
const CONTEXT_ID = "dropwave_context";
const LABEL = "Dropwave context";
/** T3 refuses a record whose payload is longer than this once written as JSON. */
const MAX_PAYLOAD = 64_000;

export type T3MessageContext = {
  version: 1;
  records: Array<{ version: 1; contextId: string; kind: string; label: string; payload: string }>;
};

/**
 * A turn's text as T3 takes it: the person's message with a link to the app's context, and that context as a record.
 * A turn with no context of the app's, or with more than T3 takes in one record, goes as it is.
 */
export function t3Message(text: string): { text: string; context?: T3MessageContext } {
  if (!text.startsWith(OPEN)) return { text };
  const end = text.indexOf(CLOSE);
  if (end < 0) return { text };
  const hidden = text.slice(0, end + CLOSE.length);
  if (JSON.stringify(hidden).length > MAX_PAYLOAD) return { text };
  const message = text.slice(end + CLOSE.length).replace(/^\n+/, "");
  return {
    text: `[${LABEL}](t3-context://v1/${KIND}/${CONTEXT_ID})\n\n${message}`,
    context: { version: 1, records: [{ version: 1, contextId: CONTEXT_ID, kind: KIND, label: LABEL, payload: hidden }] },
  };
}
