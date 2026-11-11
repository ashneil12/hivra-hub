// r66 (Alfred A10, 0.16.5): "actually bin the posts one" got "I can't delete a Mono; press Undo in Bot changes". Chief of
// Staff makes Monos from the chat, so it retires them the same way: it names the Mono (nothing happens yet), asks Ash in
// the chat, and only after his yes there is the Mono retired, with a Bot changes row whose Undo brings it back whole.
import { findMono, listMonos, monoLook, type Mono } from "../../monos/model/mono";
import { retireMono } from "../../monos/model/monoArchive";
import { recordChatRetirement } from "../../hub/model/botChanges";
import { forUser } from "../../hub/model/userName";
import { ASK_ASH_FIRST } from "./ashSaid";

export type RetireAsk = { id: string; monoId: string; name: string; by: { monoId: string; name: string }; at: number; changeId?: string };

const KEY = "monocode:mono-retire-asks";
function load(): RetireAsk[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? (list as RetireAsk[]) : [];
  } catch {
    return [];
  }
}
function save(list: RetireAsk[]): void {
  localStorage.setItem(KEY, JSON.stringify(list.slice(-50)));
}

/** A Mono on the live roster by id or name (any case); retired ones are not on it. */
function onRoster(ref: string): Mono | undefined {
  const want = ref.trim().toLowerCase();
  const roster = listMonos();
  return roster.find((m) => m.id.toLowerCase() === want) ?? roster.find((m) => monoLook(m).name.trim().toLowerCase() === want);
}

export type RetireHost = { ashSpokeSince(since: number): boolean; now?: () => number };

/**
 * mono_retire: with `mono`, names the Mono to retire (nothing happens yet); with `retireId` alone, after Ash's yes in the
 * chat, retires it (folder archived, roster entry and connectors entry kept for Undo). Any Mono's own chat may ask.
 */
export async function handleMonoRetire(input: Record<string, unknown>, caller: { monoId: string; name: string }, host: RetireHost) {
  if (!caller.monoId) throw new Error("Only a Mono's own chat retires Monos.");
  const now = host.now?.() ?? Date.now();
  if (input.retireId !== undefined) {
    if (Object.keys(input).length > 1) throw new Error("With retireId, send nothing else: the Mono you named is what gets retired.");
    const ask = load().find((a) => a.id === input.retireId && a.by.monoId === caller.monoId);
    if (!ask) throw new Error("No retire with that id from you. Name the Mono again with mono.");
    if (ask.changeId) return { retired: ask.name, alreadyRetired: true, note: forUser`${ask.name} is already retired; Undo is in Bot changes.` };
    if (!host.ashSpokeSince(ask.at)) throw new Error(forUser(ASK_ASH_FIRST));
    if (!findMono(ask.monoId)) throw new Error(forUser`${ask.name} isn't on the team any more (retired or undone already). Tell Ash in one line; nothing else to do.`);
    const retired = await retireMono(ask.monoId, new Date(now));
    if (!retired) throw new Error(forUser`${ask.name} isn't on the team any more. Tell Ash in one line.`);
    const changeId = recordChatRetirement(retired, caller.name);
    save(load().map((a) => (a.id === ask.id ? { ...a, changeId } : a)));
    return {
      retired: ask.name,
      note: forUser`${ask.name} is retired: off the sidebar and its rooms, its chats, soul and memory archived, nothing deleted. Undo is on its row in Bot changes. Tell Ash in one line.`,
    };
  }
  if (typeof input.mono !== "string" || !input.mono.trim()) throw new Error("mono must be the Mono's name or id, as on the team now.");
  const mono = onRoster(input.mono);
  if (!mono) throw new Error(forUser`No Mono called "${input.mono.trim()}" is on the team now (it may be retired already). Check the live list in <monos_now>, and tell Ash if it's already gone.`);
  if (mono.id === caller.monoId) throw new Error("You can't retire yourself.");
  if (mono.id === "checker") throw new Error("The app's checker isn't a team Mono; it can't be retired.");
  const name = monoLook(mono).name;
  const ask: RetireAsk = { id: `retire-${mono.id}-${now.toString(36)}`, monoId: mono.id, name, by: caller, at: now };
  save([...load().filter((a) => !(a.monoId === mono.id && !a.changeId)), ask]);
  return {
    retireId: ask.id,
    mono: name,
    note: forUser`Nothing is retired yet. Ask Ash in one line whether to retire ${name} (off the sidebar and its rooms, its chats and memory archived, Undo in Bot changes) and end your turn. After his yes in the chat, call mono_retire with only retireId.`,
  };
}
