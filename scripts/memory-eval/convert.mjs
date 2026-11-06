// The memory eval's converter: a PersonalizationV4 test row, turned into the doc Hivra's recall policy reads.
//
// Pure: it reads plain objects and strings, never the disk or the network. Anything it cannot read becomes a
// dropped row, not a crash. The fetch, the parquet read and the report live in ../memory-eval.mjs.

/** The Mono whose memory is measured: the coding team's. */
export const EVAL_MATE = "memory-eval";

/** Every fact a test doc carries is the person's own words, so recall treats it as confirmed. */
export const EVAL_STATE = "confirmed";

/** A fixed timestamp for every memory, so recency never decides the eval and two runs agree. */
export const EVAL_NOW = Date.UTC(2026, 0, 1);

const MAX_FACT_CHARS = 400;

/**
 * Where the assistant's reply starts in a chat: on a line of its own, or after a space mid-line. A few rows
 * carry the line break as the two characters `\n` instead of a newline, so both count as a break.
 */
const REPLY_AT = /(?:\s|\\+n)+Assistant:/;

/**
 * The text of one chat's user turn, with the fixed speaker tag and the assistant's reply taken off. A chat
 * that starts with the assistant has no user turn, so it yields nothing: only the person's own words become
 * a memory, never the model's. The test split writes a chat as "Leo: <turn>  \nAssistant: <reply>", but the
 * reply is cut wherever it starts, so a chat glued onto one line still gives up its user turn alone.
 */
export function userTurn(chat) {
  if (typeof chat !== "string") return "";
  let body = chat.trim();
  if (body.startsWith("Assistant:")) return "";
  if (body.startsWith("Leo:")) body = body.slice(4).trim();
  const reply = REPLY_AT.exec(body);
  if (reply) body = body.slice(0, reply.index);
  return body.trim();
}

/** A long chat cut into snippets at a sentence end near the limit: a fact is one sentence, not a pasted chat. */
export function snippetsOf(body, max = MAX_FACT_CHARS) {
  if (body.length <= max) return body ? [body] : [];
  const out = [];
  let rest = body;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const stop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    let at;
    if (stop >= max / 2) at = stop + 1;
    else {
      // No sentence end late enough in the window: cut at a word break, never inside a word.
      const space = window.lastIndexOf(" ");
      at = space > 0 ? space : max;
    }
    const piece = rest.slice(0, at).trim();
    if (!piece) break;
    out.push(piece);
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * One memory per conversation snippet, which is how Hivra's chat importer keeps a fact: a single line in the
 * person's own words, confirmed so the automatic policy may recall it, with the chat it came from as its source.
 * A repeated snippet (the same chat twice) becomes one memory, not two.
 */
export function memoriesForDocs(docs, { mateId = EVAL_MATE, now = EVAL_NOW, memoryId } = {}) {
  if (typeof memoryId !== "function") throw new Error("memoriesForDocs needs the memoryId function.");
  const items = [];
  const seen = new Set();
  if (!Array.isArray(docs)) return items;
  docs.forEach((chat, chatIndex) => {
    const body = userTurn(chat);
    if (!body) return;
    const label = `chat ${chatIndex + 1}`;
    snippetsOf(body).forEach((text, part) => {
      const id = memoryId([mateId, `chat-${chatIndex}`, `part-${part}`, text]);
      if (seen.has(id)) return;
      seen.add(id);
      items.push({
        id,
        mateId,
        action: "add",
        text,
        state: EVAL_STATE,
        source: { kind: "import", ref: `chat-${chatIndex}`, label },
        evidence: text,
        support: 1,
        against: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
  });
  return items;
}

/** The doc one test user's chats become: one revision, every snippet, nothing else. */
export function docForUser(docs, options = {}) {
  return { revision: 1, generation: 1, items: memoriesForDocs(docs, options), doneTurns: [], imports: {} };
}

/** The text of an optional parquet column value: a byte array, a string, or nothing. */
export function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

/** The list of texts of an optional list column row, with empty entries dropped and repeats kept in order. */
export function asTexts(value) {
  if (!Array.isArray(value)) return [];
  return value.map(asText).filter((text) => text.length > 0);
}

/**
 * One question, read from a row of columns. A row whose question or answer is blank is dropped, because a
 * question with nothing to answer tells the eval nothing.
 */
export function questionOf(row) {
  const question = asText(row.question).trim();
  const answer = asText(row.answer).trim();
  if (!question || !answer) return undefined;
  return {
    userId: typeof row.userId === "number" && Number.isFinite(row.userId) ? row.userId : undefined,
    question,
    answer,
    choices: asTexts(row.choices),
    hard: row.hard === true,
  };
}

/** The chats of a documents row that carry a user turn. */
export function usableDocs(value) {
  return asTexts(value).filter((chat) => userTurn(chat).length > 0);
}
