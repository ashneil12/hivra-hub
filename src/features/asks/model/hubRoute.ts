// Asks said in a hub chat that is no first mate's (a plain chat, a team room) are written into the ask ledger here. The
// old hub ledger caught them (dumpCheck.noteDumps wrote every dump of any chat into it); Ledger A hears only a first
// mate's own chats (askMate.ts), so folding the two together without this would have lost them. They go in through the
// same hearing the hook uses (store.hear, the wide no-model reading), owned by no first mate (HUB_MATE) and quiet: they
// show on the Chief's "You asked" list and are settled against the build like any other, but no chat shows a receipt for
// them and no first mate is nudged about them.
//
// A first mate's chat is left to the hook (useAskLedger.ts), which hears it with the model too.
import { askStore, type AskStore } from "./askStore";
import { ASKS_PER_MESSAGE, HUB_MATE } from "./asks";
import { wideAsks } from "./wideReading";

export type HubDump = { chatId: string; blockId: string; text: string; /** When Ash sent it. */ at: number };

/**
 * Writes one dump's asks into the ledger when its chat is no first mate's. A message is heard once: a second delivery
 * (the dump noticed again after a restart, another pass) changes nothing. Resolves to whether it wrote anything.
 */
export async function routeHubDump(dump: HubDump, mateOf: (chatId: string) => string | undefined, store: AskStore = askStore()): Promise<boolean> {
  if (mateOf(dump.chatId)) return false;
  const reading = wideAsks(dump.text);
  if (!reading.length) return false;
  const doc = await store.load();
  if (doc.heard[dump.blockId]) return false;
  await store.hear({
    mateId: HUB_MATE,
    sessionId: dump.chatId,
    blockId: dump.blockId,
    list: { asks: reading.slice(0, ASKS_PER_MESSAGE), maybes: [] },
    by: "rules",
    quiet: true,
    now: Number.isFinite(dump.at) && dump.at >= 0 ? dump.at : Date.now(),
  });
  return true;
}
