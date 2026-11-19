// Test helpers for what reads and settles asks in a hub chat (hub/model/askSettle.ts, dumpCheck.ts): a fresh ask ledger for
// each test, and a way to say an ask in a chat the way the app writes it (hubRoute.ts). The ledger is the one the app
// reads, on the in-memory disk its own tests use.
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { openAskRows, type AskedRow } from "../model/askedView";
import { askStore, createAskStore, setAskStore, type AskStore } from "../model/askStore";
import { routeHubDump } from "../model/hubRoute";

/** A new, empty ask ledger as the window's own, for one test. Call `setAskStore(undefined)` after. */
export function freshAskStore(now: () => number = Date.now): AskStore {
  const store = createAskStore(memoryDisk(), now);
  setAskStore(store);
  return store;
}

/** An ask said in a hub chat, written into the window's ledger. Resolves once it is there. */
export async function sayInHub(chatId: string, blockId: string, text: string, at: number = Date.now()): Promise<void> {
  await routeHubDump({ chatId, blockId, text, at }, () => undefined, askStore());
}

/** The open asks (one chat's when named) as the dump check reads them. */
export function openAsksIn(chatId?: string): AskedRow[] {
  return openAskRows(askStore().doc(), chatId);
}
