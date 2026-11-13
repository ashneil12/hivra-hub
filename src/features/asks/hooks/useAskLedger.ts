// The ask ledger's two moments in a first mate's chat (model/asks.ts), in the Hub bundle's main window only, so two
// windows never hear one message twice:
// - Ash's message arrives: its asks are written to the ledger. The no-model reading goes in at once; a long message
//   also gets one background model call whose list (checked word for word against the message) replaces it. The turn
//   never waits on either.
// - a turn ends: asks from his message that still have no status get one app message (askNotes.ts askNudge).
// A message from before the ledger began is never read, and neither is a private chat (memory/model/privateChat.ts).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { memoryReadableBlocks } from "../../memory/model/privateChat";
import { readLegacyAskLedger } from "../../hub/model/askLedger";
import { askDigest, askNudge, isAshMessage } from "../model/askNotes";
import { chaseOf, pendingReminders, quietCheckOnlyDue, raisedAsks, remindMessage } from "../model/askQuiet";
import { HUB_MATE, hearMessage, hearPrompt, nothingToHear, parseHeard, rulesAsks, sentences, type HeardAsk } from "../model/asks";
import { askStore } from "../model/askStore";
import { wideAsks } from "../model/wideReading";

/** A message this long, or with this many sentences, gets the model's reading. A shorter one is read by the rules. */
const LONG_CHARS = 200;
const LONG_SENTENCES = 3;
/** The model is tried this many times for one message (once at send, once more when the chat next goes quiet). */
const MODEL_TRIES = 2;
/** At most this many model readings at once. */
const RUNNING_MAX = 2;

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

export function isLongMessage(text: string): boolean {
  return text.trim().length >= LONG_CHARS || sentences(text).length >= LONG_SENTENCES;
}

/**
 * Whether a message's asks show in its chat. One short ask is just a message: the reply answers it and a receipt under
 * every line would be noise (and the first mate is not nudged about it). Two or more asks, or anything asked in a long
 * message, get the receipt. The others are still written down, quietly (Ask.quiet), so the Chief's "You asked" list has
 * them: it held every ask the old hub ledger caught, a lone short one included.
 */
export function worthKeeping(text: string, asks: readonly HeardAsk[], maybes: readonly HeardAsk[]): boolean {
  const total = asks.length + maybes.length;
  if (total >= 2) return true;
  return asks.length >= 1 && isLongMessage(text);
}

export type AskLedgerOptions = {
  sessions: readonly Session[];
  enabled: boolean;
  /** The first mate a chat belongs to, or none for a worker, a room or a plain chat. */
  mateOf: (sessionId: string) => string | undefined;
  /** One isolated text call, no tools. Absent when no engine can make it: the rules' reading stands. */
  ask?: (prompt: string) => Promise<string>;
  /** Sends an app message to a chat when it is idle. */
  send?: (chatId: string, message: QueuedMessage) => Promise<unknown> | void;
  /** The app CLI's command, for the note that says how to set a status. */
  cli: () => Promise<string>;
};

export function useAskLedger(options: AskLedgerOptions): void {
  const on = options.enabled && isMainWindow();
  const latest = useRef(options);
  latest.current = options;
  /** User messages a chat already held when this run first saw it: history, not news. */
  const baseline = useRef(new Map<string, Set<string>>());
  const inFlight = useRef(new Set<string>());
  const waiting = useRef<Array<() => void>>([]);
  const running = useRef(0);
  const nudged = useRef(new Set<string>());
  const digesting = useRef(new Set<string>());
  /** Reminders (askQuiet.ts) being sent, by ask id and the time the person asked. */
  const reminding = useRef(new Set<string>());
  // A ledger change (this window's or another's) runs the pass again with the chats as they stand.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!on) return;
    const store = askStore();
    void store
      .load()
      .then(() => store.begin())
      // The old hub ledger's open asks come in once (askMove.ts). A key that cannot be read leaves the move for the next
      // start; the old key itself is never written or deleted here.
      .then(() => {
        const legacy = readLegacyAskLedger();
        if (legacy.ok) return store.moveFromHub(legacy.rows, (chatId) => latest.current.mateOf(chatId));
      })
      .catch(() => undefined);
    return store.subscribe(() => setTick((value) => value + 1));
  }, [on]);

  useEffect(() => {
    if (!on) return;
    const store = askStore();
    if (!store.loaded()) return;
    const doc = store.doc();
    const { mateOf, ask, send, cli } = latest.current;

    const slot = async <R,>(work: () => Promise<R>): Promise<R> => {
      if (running.current >= RUNNING_MAX) await new Promise<void>((go) => waiting.current.push(go));
      running.current += 1;
      try {
        return await work();
      } finally {
        running.current -= 1;
        waiting.current.shift()?.();
      }
    };

    for (const session of options.sessions) {
      const mateId = mateOf(session.id);
      if (!mateId) continue;
      const readable = memoryReadableBlocks(session);
      // A message from Ash in the chat a quiet ask was raised in answers it: its Needs you row goes (askQuiet.ts).
      for (const raised of raisedAsks(doc)) {
        const at = chaseOf(raised)?.raisedAt ?? 0;
        if (raised.sessionId === session.id && readable.some((block) => isAshMessage(block) && (block.startedAt ?? 0) > at))
          void store.answered(raised.id, at).catch(() => undefined);
      }
      let seen = baseline.current.get(session.id);
      const first = !seen;
      if (!seen) {
        seen = new Set(readable.filter(isAshMessage).map((block) => block.id));
        baseline.current.set(session.id, seen);
      }
      for (const block of readable) {
        if (!isAshMessage(block)) continue;
        const text = block.text;
        const mark = doc.heard[block.id];
        const fresh = (block.startedAt ?? 0) >= doc.since || (!first && !seen.has(block.id));
        if (!fresh || inFlight.current.has(block.id)) continue;
        const base = { mateId, sessionId: session.id, blockId: block.id };
        if (!mark) {
          // The quick reading, at once, so the receipt is there before the model answers.
          inFlight.current.add(block.id);
          const quick = nothingToHear(text) ? [] : wideAsks(text);
          const long = isLongMessage(text) && !nothingToHear(text);
          // Every ask is written down. Whether the chat shows it is the rules' own call, as it always was: a short message
          // (a lone ask, or two in two short sentences) is written quietly.
          const keep = worthKeeping(text, rulesAsks(text), []);
          void store
            .hear({ ...base, list: { asks: quick, maybes: [] }, by: long && ask ? "rules" : quick.length ? "rules" : "model", now: Date.now(), ...(keep ? {} : { quiet: true }) })
            .catch(() => undefined)
            .finally(() => inFlight.current.delete(block.id));
          continue;
        }
        // The model's reading of a long message: once at send, once more when the chat has gone quiet.
        if (mark.by !== "rules" || !ask || !isLongMessage(text)) continue;
        if (mark.tries > MODEL_TRIES || (mark.tries === MODEL_TRIES && session.busy)) continue;
        inFlight.current.add(block.id);
        void slot(async () => {
          let heard: HeardAsk[] | undefined;
          try {
            heard = parseHeard(await ask(hearPrompt(text)), text);
          } catch {
            heard = undefined;
          }
          const now = Date.now();
          if (!heard) {
            // No list this time. Count the try; the rules' reading stays.
            const quick = wideAsks(text);
            await store.hear({ ...base, list: { asks: quick, maybes: [] }, by: "rules", now, ...(worthKeeping(text, rulesAsks(text), []) ? {} : { quiet: true }) });
            return;
          }
          const list = hearMessage(text, heard, wideAsks(text));
          // The message is long here, so any row at all is worth keeping, as the quick reading kept a lone rules ask: an
          // empty list written over it would erase a row the person was shown.
          const keep = list.asks.length + list.maybes.length > 0;
          await store.hear({ ...base, list: keep ? list : { asks: [], maybes: [] }, by: "model", now });
        })
          .catch(() => undefined)
          .finally(() => inFlight.current.delete(block.id));
      }

      // A turn that ended with asks nobody gave a status.
      if (!send || session.busy) continue;
      if (readable.some((block) => inFlight.current.has(block.id))) continue;
      // A long message still waiting on the model's first reading is not judged on the rules' quick one.
      const pending = readable.some((block) => isAshMessage(block) && doc.heard[block.id]?.by === "rules" && doc.heard[block.id].tries < MODEL_TRIES && !!ask && isLongMessage(block.text));
      if (pending) continue;
      const candidate = askNudge(session, doc, mateId, "app", nudged.current);
      if (!candidate) continue;
      const replyId = candidate.id.replace(/^asks-owed-/, "");
      nudged.current.add(replyId);
      void cli()
        .then((command) => {
          const message = askNudge(session, store.doc(), mateId, command, new Set());
          if (message) return send(session.id, message);
        })
        .catch(() => undefined);
    }

    // The daily check: a first mate whose asks went quiet hears of it once a day, in the chat the oldest was made in, or
    // (A5) the next quiet ask's chat when that one can't take it.
    if (send) {
      const now = Date.now();
      const mates = new Set(doc.asks.map((item) => item.mateId));
      for (const mateId of mates) {
        // Asks heard in a chat that is no first mate's have nobody to tell (hubRoute.ts).
        if (mateId === HUB_MATE || digesting.current.has(mateId)) continue;
        // Only into a chat that is open, idle and still this first mate's; with none, nothing is marked sent and a later pass tries again.
        const takes = (chatId: string) => {
          const chat = options.sessions.find((session) => session.id === chatId);
          return !!chat && !chat.busy && !chat.queuedMessages?.length && mateOf(chat.id) === mateId;
        };
        const due = askDigest(doc, mateId, "app", now, takes);
        if (!due) {
          // Nothing to tell this first mate, but an ask waiting on Ash has been quiet: the check is made and only its count moves.
          if (quietCheckOnlyDue(doc, mateId, now)) {
            digesting.current.add(mateId);
            void store
              .markDigest(mateId)
              .catch(() => undefined)
              .finally(() => digesting.current.delete(mateId));
          }
          continue;
        }
        digesting.current.add(mateId);
        void store
          .markDigest(mateId)
          .then(() => cli())
          .then((command) => {
            // The chat was chosen above, with the chats as they stood. Only the text is made again (it needs the command and
            // the asks as they stand now); asked about the chats a second time it could find none and drop a check already marked.
            const again = askDigest({ ...store.doc(), nudged: { ...store.doc().nudged, [mateId]: 0 } }, mateId, command, Date.now());
            if (again) return send(due.chatId, again.message);
          })
          .catch(() => undefined)
          .finally(() => digesting.current.delete(mateId));
      }

      // A reminder the person asked for on a quiet ask (askQuiet.ts), sent once, to the ask's own chat or another of its first
      // mate's that can take it. A busy or closed chat leaves it queued in the ledger for a later pass.
      for (const ask of pendingReminders(doc)) {
        const remindAt = chaseOf(ask)?.remindAt;
        if (remindAt === undefined || reminding.current.has(`${ask.id}:${remindAt}`)) continue;
        const takes = (chatId: string) => {
          const chat = options.sessions.find((session) => session.id === chatId);
          return !!chat && !chat.busy && !chat.queuedMessages?.length && mateOf(chat.id) === ask.mateId;
        };
        const chatId = [ask.sessionId, ...options.sessions.map((session) => session.id)].find(takes);
        if (chatId === undefined) continue;
        const key = `${ask.id}:${remindAt}`;
        reminding.current.add(key);
        void cli()
          .then(async (command) => {
            // The ask as it stands now: one that moved or closed while the command was fetched is not reminded of.
            const current = store.doc().asks.find((item) => item.id === ask.id);
            if (!current || chaseOf(current)?.remindAt !== remindAt) return;
            await send(chatId, remindMessage(current, command, remindAt));
            await store.reminderSent(ask.id, remindAt);
          })
          .catch(() => undefined)
          .finally(() => reminding.current.delete(key));
      }
    }
  }, [on, options.sessions, tick]);
}
