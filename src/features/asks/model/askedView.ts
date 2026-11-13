// What the Chief of Staff's "You asked" list and the dump check read (README gap H5: two ledgers disagreed). One small
// read model over Ledger A, the ask ledger (asks.ts). The list used to read the hub ledger (hub/model/askLedger.ts, rows
// `open handled parked dropped`); it now reads the same asks the first mates work on, so what a first mate or a finished
// job says about an ask shows there. A row keeps the shape the list had (a short title, his words, when, and one of the
// four words) and adds what Ledger A knows beyond it (working, waiting on him, a maybe).
import { isOpen, type Ask, type AskDoc, type AskKind, type AskStatus } from "./asks";

export type AskedRow = {
  id: string;
  /** The chat the ask was made in. */
  chatId: string;
  /** The message of his it came from. */
  blockId: string;
  /** One short line naming what he asked. */
  title: string;
  /** His words, copied exactly. */
  words: string;
  /** Epoch ms, when the message arrived. */
  at: number;
  status: AskStatus;
  /** An idea for later is on the list but is not an ask to do now, so the dump check leaves it alone. */
  kind: AskKind;
  /** Still to do: not done and not dropped. */
  open: boolean;
  /** The word the list shows. The old words stay where the old ledger had them: Open, Done. */
  word: string;
  /** What closed it, or where it stands: the proof of a done ask, else what the build left open, else the first mate's note. */
  note?: string;
  /** How many times he has said it (more than once). */
  said?: number;
  /** An ask that waits on him, or one the build did not cover, shows in red. */
  red: boolean;
  /** The checks (hub/model/askSettle.ts) already acted on for this ask. */
  check?: Ask["check"];
};

const TITLE_MAX = 90;

function titleOf(ask: Ask): string {
  const line = (ask.summary || ask.quote).replace(/\s+/g, " ").trim();
  const cut = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 3).replace(/\s+\S*$/, "")}…` : line;
  return cut.replace(/[.,;:]+$/, "");
}

function wordOf(ask: Ask): string {
  switch (ask.status) {
    case "heard":
      return ask.kind === "idea" ? "Idea, for later" : "Open";
    case "maybe":
      return "Maybe an ask";
    case "started":
      return "Working";
    case "waiting":
      return "Waiting on you";
    case "done":
      return "Done";
    case "dropped":
      return "Dropped";
  }
}

export function askedRow(ask: Ask): AskedRow {
  const open = isOpen(ask);
  const gap = ask.check?.gap;
  const note = ask.status === "done" ? ask.proof : [gap, ask.note].filter(Boolean).join(" · ") || undefined;
  return {
    id: ask.id,
    chatId: ask.sessionId,
    blockId: ask.blockId,
    title: titleOf(ask),
    words: ask.quote,
    at: ask.createdAt,
    status: ask.status,
    kind: ask.kind,
    open,
    word: wordOf(ask),
    ...(note ? { note } : {}),
    ...(ask.said && ask.said > 1 ? { said: ask.said } : {}),
    red: ask.status === "waiting" || (open && !!gap),
    ...(ask.check ? { check: ask.check } : {}),
  };
}

/** The asks on the list, newest first: everything but what he dropped (a "Not an ask" is gone from it too). */
export function askedRows(doc: AskDoc): AskedRow[] {
  return doc.asks
    .filter((ask) => ask.status !== "dropped")
    .map(askedRow)
    .reverse();
}

/** What the "You asked" chip counts. */
export function askedOpenCount(rows: readonly AskedRow[]): number {
  return rows.filter((row) => row.open).length;
}

/** The open asks (the dump check settles these), oldest first; one chat's when a chat is named. Ideas are not asks to settle. */
export function openAskRows(doc: AskDoc, chatId?: string): AskedRow[] {
  return doc.asks
    .filter((ask) => isOpen(ask) && ask.kind !== "idea" && (!chatId || ask.sessionId === chatId))
    .map(askedRow);
}

/** One of his messages' asks in one chat. */
export function askedFor(doc: AskDoc, chatId: string, blockId: string): AskedRow[] {
  return doc.asks.filter((ask) => ask.sessionId === chatId && ask.blockId === blockId).map(askedRow);
}

/**
 * The one quiet line a check card shows under its finding: the asks from that message that are still open. Empty when
 * there are none, so a check about chatter adds nothing.
 */
export function openAskLineFor(doc: AskDoc, blockId: string): string {
  const rows = doc.asks.filter((ask) => ask.blockId === blockId && isOpen(ask) && ask.kind !== "idea").map(askedRow);
  if (!rows.length) return "";
  const titles = rows.slice(0, 3).map((row) => row.title);
  return `Still open: ${titles.join("; ")}${rows.length > 3 ? ` (+${rows.length - 3} more)` : ""}`;
}
