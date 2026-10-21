import { invoke } from "@tauri-apps/api/core";
import { flowChanges, undoBotChange } from "../../hub/model/botChanges";
import { offerChange, offeredChanges, registerChangeKind } from "./changeFlow";

/**
 * Change the hub itself by talking (ash-day step 15). A Mono passes Ash's words to `startHubChange`: the app makes a
 * preview copy of the hub's own repo (src-tauri/src/self_build.rs) and a Claude Code worker makes the change there, one
 * commit per part. On its report the Mono calls `readyHubChange`: Ash gets Now | Preview, Apply and Discard (the
 * shared change bar). Each applied commit is its own Bot changes row, so "undo that colour" undoes only that one.
 * What may change is decided in Rust; a refusal comes back in plain words.
 */
export const HUB_CODE = "hub-code";

export type HubCodeCommands = {
  prepare(id: string): Promise<{ id: string; folder: string; base: string }>;
  collect(id: string): Promise<{ commits: { sha: string; subject: string; files: string[] }[]; blocked: { path: string; area: string }[] }>;
  preview(id: string, on: boolean): Promise<void>;
  apply(id: string): Promise<{ sha: string; subject: string }[]>;
  discard(id: string): Promise<void>;
  revert(sha: string): Promise<string>;
  ping(): Promise<void>;
  live(): Promise<string | null>;
};
let commands: HubCodeCommands = {
  prepare: (id) => invoke("hub_change_prepare", { id }),
  collect: (id) => invoke("hub_change_collect", { id }),
  preview: (id, on) => invoke("hub_change_preview", { id, on }),
  apply: (id) => invoke("hub_change_apply", { id }),
  discard: (id) => invoke("hub_change_discard", { id }),
  revert: (sha) => invoke("hub_change_revert", { sha }),
  ping: () => invoke("hub_change_ping"),
  live: () => invoke("hub_change_live"),
};
export function setHubCodeCommands(next: HubCodeCommands): void {
  commands = next;
}
const plain = (e: unknown) => new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't go through.");

/** While a preview shows, the window says it's still there; without that, Rust takes the preview out. */
let pinger: ReturnType<typeof setInterval> | undefined;
function keepPinging(on: boolean): void {
  if (on && !pinger) pinger = setInterval(() => void commands.ping().catch(() => undefined), 5_000);
  if (!on && pinger) {
    clearInterval(pinger);
    pinger = undefined;
  }
}

type Part = { sha: string };
registerChangeKind(HUB_CODE, {
  preview: async (data, on) => {
    await commands.preview((data as { id: string }).id, on).catch((e) => Promise.reject(plain(e)));
    keepPinging(on);
  },
  apply: async (data) => {
    const applied = await commands.apply((data as { id: string }).id).catch((e) => Promise.reject(plain(e)));
    keepPinging(false);
    return applied.map((c) => ({ title: c.subject || "Hub change", data: { sha: c.sha } satisfies Part }));
  },
  discard: async (data) => {
    await commands.discard((data as { id: string }).id).catch((e) => Promise.reject(plain(e)));
    keepPinging(false);
  },
  undo: (part) => commands.revert((part as Part).sha).catch((e) => Promise.reject(plain(e))),
  redo: async (_part, undone) => {
    if (typeof undone !== "string") throw new Error("Nothing to redo.");
    await commands.revert(undone).catch((e) => Promise.reject(plain(e)));
  },
});

const pending = new Map<string, { title: string; by: string; ask: string }>();

/** Make the preview copy. Returns its id and folder, for the worker's brief. */
export async function startHubChange(ask: string, title: string | undefined, by: string, now = Date.now()) {
  const id = `hc-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const change = await commands.prepare(id).catch((e) => Promise.reject(plain(e)));
  pending.set(id, { title: title?.trim() || ask.split("\n")[0].slice(0, 120), by, ask });
  return { changeId: id, folder: change.folder };
}

/** The brief the Claude Code worker gets: Ash's words and where to work. The limits are enforced, not asked for. */
export function hubChangeBrief(ask: string, folder: string): string {
  return [
    `Ash asked for a change to MonoCode Hub itself: "${ask}"`,
    `Make it in ${folder}, a preview copy of the hub's own code. The running hub doesn't change until Ash clicks Apply.`,
    "One git commit per separate part of the ask, each subject a few plain words Ash can read (\"New chat button is at the top\").",
    "Only src/ and public/ can change, and not Settings, keys, the Monos list or src/main.tsx: the app refuses those. If the ask needs them, say so plainly instead.",
    "Use the theme tokens for colour. Run npx tsc --noEmit and the tests of what you touched, then report each commit in one line.",
  ].join("\n");
}

/** The worker is done: show Ash Now | Preview. A change that touches the protected core is thrown away, said plainly. */
export async function readyHubChange(changeId: string, by: string) {
  if (!/^hc-[a-z0-9]+$/.test(changeId)) throw new Error("No hub change with that id. Start one with hub_change {ask}.");
  const known = pending.get(changeId) ?? offeredChanges().find((o) => o.id === changeId) ?? { title: "Your hub change", by };
  const got = await commands.collect(changeId).catch((e) => Promise.reject(plain(e)));
  if (got.blocked.length) {
    await commands.discard(changeId).catch(() => undefined);
    pending.delete(changeId);
    const areas = [...new Set(got.blocked.map((b) => b.area))].join(", ");
    throw new Error(`That change touches ${areas}, which stays protected, so it can't go in. It was thrown away and nothing changed. Tell Ash in those words.`);
  }
  if (!got.commits.length) throw new Error("The preview copy has no changes yet: wait for the worker's report.");
  const parts = got.commits.map((c) => c.subject || "Hub change");
  offerChange({ id: changeId, kind: HUB_CODE, title: known.title, by: known.by, data: { id: changeId }, parts });
  pending.delete(changeId);
  return {
    changeId,
    parts,
    note: "Ash sees it at the bottom of the window: Now | Preview, Apply, Discard. Tell him in one line; he clicks.",
  };
}

/** "undo that colour": the applied part whose title (or commit) matches, undone alone. */
export async function undoHubPart(which: string) {
  const want = which.trim().toLowerCase();
  const rows = flowChanges(HUB_CODE).filter((c) => !c.undone);
  const row =
    rows.find((c) => (c.flow?.data as Part | undefined)?.sha?.startsWith(want) || c.id === which) ??
    rows.find((c) => c.after.toLowerCase() === want) ??
    rows.find((c) => c.after.toLowerCase().includes(want) || want.includes(c.after.toLowerCase()));
  if (!row)
    throw new Error(`No applied hub change matches "${which}". Applied: ${rows.map((c) => `"${c.after}"`).join(", ") || "none"}.`);
  await undoBotChange([row.id]);
  const after = flowChanges(HUB_CODE).find((c) => c.id === row.id);
  if (after?.problem) throw new Error(after.problem);
  return { undone: row.after, note: "Only that part went back; it can be redone in Bot changes." };
}

/** A reloaded window picks a live preview back up (else Rust takes it out after 30 s). */
export async function resumeLivePreview(): Promise<void> {
  const id = await commands.live().catch(() => null);
  if (!id || offeredChanges().some((o) => o.id === id)) return;
  offerChange({ id, kind: HUB_CODE, title: "Your hub change (preview is on)", by: "A Mono", data: { id }, previewing: true });
  keepPinging(true);
}
