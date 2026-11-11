import { invoke } from "@tauri-apps/api/core";
import { flowChanges, undoBotChange } from "../../hub/model/botChanges";
import { offerChange, offeredChanges, registerChangeKind } from "./changeFlow";
import { forUser } from "../../hub/model/userName";

/**
 * Change the hub itself by talking (ash-day step 15). A Mono passes Ash's words to `startHubChange`: the app makes a
 * preview copy of the hub's own repo (src-tauri/src/self_build.rs) and a Claude Code worker makes the change there, one
 * commit per part. On its report the Mono calls `readyHubChange`: Ash gets Now | Preview, Apply and Discard (the
 * shared change bar). Each applied commit is its own Bot changes row, so "undo that colour" undoes only that one.
 * What may change is decided in Rust; a refusal comes back in plain words.
 */
export const HUB_CODE = "hub-code";

/** How this copy puts a change in: a dev copy shows it in place, the installed app builds and ships it. */
export type HubDelivery = "inPlace" | "rebuild";

export type HubCodeCommands = {
  prepare(id: string): Promise<{ id: string; folder: string; base: string; delivery: HubDelivery }>;
  collect(id: string): Promise<{ delivery: HubDelivery; commits: { sha: string; subject: string; files: string[] }[]; blocked: { path: string; area: string }[] }>;
  preview(id: string, on: boolean): Promise<void>;
  apply(id: string): Promise<{ sha: string; subject: string }[]>;
  discard(id: string): Promise<void>;
  revert(sha: string): Promise<string>;
  ping(): Promise<void>;
  live(): Promise<{ id: string; delivery: HubDelivery } | null>;
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

type Part = { sha: string; delivery?: HubDelivery };
type ChangeData = { id: string; delivery?: HubDelivery };
/** The installed app's preview is a browser page that outlives the window, so only an in-place one is kept alive. */
const watches = (data: unknown, on: boolean) => on && (data as ChangeData).delivery !== "rebuild";

registerChangeKind(HUB_CODE, {
  preview: async (data, on) => {
    await commands.preview((data as ChangeData).id, on).catch((e) => Promise.reject(plain(e)));
    keepPinging(watches(data, on));
  },
  apply: async (data) => {
    const applied = await commands.apply((data as ChangeData).id).catch((e) => Promise.reject(plain(e)));
    keepPinging(false);
    return applied.map((c) => ({
      title: c.subject || "App change",
      data: { sha: c.sha, delivery: (data as ChangeData).delivery } satisfies Part,
    }));
  },
  discard: async (data) => {
    await commands.discard((data as ChangeData).id).catch((e) => Promise.reject(plain(e)));
    keepPinging(false);
  },
  undo: (part) => commands.revert((part as Part).sha).catch((e) => Promise.reject(plain(e))),
  redo: async (_part, undone) => {
    if (typeof undone !== "string") throw new Error("Nothing to redo.");
    await commands.revert(undone).catch((e) => Promise.reject(plain(e)));
  },
});

const pending = new Map<string, { title: string; by: string; ask: string; delivery: HubDelivery }>();

/** Make the preview copy. Returns its id and folder, for the worker's brief. */
export async function startHubChange(ask: string, title: string | undefined, by: string, now = Date.now()) {
  const id = `hc-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const change = await commands.prepare(id).catch((e) => Promise.reject(plain(e)));
  pending.set(id, {
    title: title?.trim() || ask.split("\n")[0].slice(0, 120),
    by,
    ask,
    delivery: change.delivery,
  });
  return { changeId: id, folder: change.folder, delivery: change.delivery };
}

/** What the bar says for each way a change reaches the app; a dev copy's in-place preview needs no special words. */
function deliveryText(delivery: HubDelivery) {
  if (delivery !== "rebuild") return {};
  return {
    nowText: "Now: your app as it is.",
    previewText: "Preview: open in your browser.",
    applyText: "Rebuild and ship",
    workingText: "Building the app with your change, then it restarts by itself. This takes a few minutes.",
  };
}

/** The brief the Claude Code worker gets: Ash's words and where to work. The limits are enforced, not asked for. */
export function hubChangeBrief(ask: string, folder: string): string {
  return [
    forUser`Ash asked for a change to MonoCode Hub itself: "${ask}"`,
    forUser`Make it in ${folder}, a preview copy of the app's own code. The running app doesn't change until Ash clicks Apply.`,
    forUser("One git commit per separate part of the ask, each subject a few plain words Ash can read (\"New chat button is at the top\")."),
    "Only how the app looks and works on a screen can change here: src/ and public/, but not the engine (src/integrations, src/platform, src/features/sessions/model, src/features/hub/model, src/features/agent-app), Settings, keys, the Monos list or src/main.tsx. Those need a real build and go to the MonoCode Hub lead; the app refuses them here, so say so plainly if the ask needs one.",
    "Use the theme tokens for colour. Run npx tsc --noEmit and the tests of what you touched, then report each commit in one line.",
  ].join("\n");
}

/** The worker is done: show Ash Now | Preview. A change that touches the protected core is thrown away, said plainly. */
export async function readyHubChange(changeId: string, by: string) {
  if (!/^hc-[a-z0-9]+$/.test(changeId)) throw new Error("No app change with that id. Start one with hub_change {ask}.");
  const known = pending.get(changeId) ?? offeredChanges().find((o) => o.id === changeId) ?? { title: "Your app change", by };
  const got = await commands.collect(changeId).catch((e) => Promise.reject(plain(e)));
  if (got.blocked.length) {
    await commands.discard(changeId).catch(() => undefined);
    pending.delete(changeId);
    const areas = [...new Set(got.blocked.map((b) => b.area))].join(", ");
    throw new Error(forUser`That change touches ${areas}, which has to be built and checked before it lands, so it can't go in here. It was thrown away and nothing changed. Tell Ash in those words: it goes to the MonoCode Hub lead.`);
  }
  if (!got.commits.length) throw new Error("The preview copy has no changes yet: wait for the worker's report.");
  const parts = got.commits.map((c) => c.subject || "App change");
  offerChange({
    id: changeId,
    kind: HUB_CODE,
    title: known.title,
    by: known.by,
    data: { id: changeId, delivery: got.delivery } satisfies ChangeData,
    parts,
    ...deliveryText(got.delivery),
  });
  pending.delete(changeId);
  return {
    changeId,
    parts,
    note: forUser("Ash sees it at the bottom of the window: Now | Preview, Apply, Discard. Tell him in one line; he clicks."),
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
    throw new Error(`No applied app change matches "${which}". Applied: ${rows.map((c) => `"${c.after}"`).join(", ") || "none"}.`);
  // A rebuild undo runs the checks, the build and the ship with no tap (hub_change_revert). Ash's Undo in Bot
  // changes still does that, because that button is the tap. A chat asking for the same undo is not.
  // A row applied before the delivery tag holds the commit alone. Refuse unless this part is known to be in place.
  if ((row.flow?.data as Part | undefined)?.delivery !== "inPlace") {
    throw new Error("That change is not known to be in place. Undo it from Bot changes, so a chat does not rebuild and ship it.");
  }
  await undoBotChange([row.id]);
  const after = flowChanges(HUB_CODE).find((c) => c.id === row.id);
  if (after?.problem) throw new Error(after.problem);
  return { undone: row.after, note: "Only that part went back; it can be redone in Bot changes." };
}

/** A reloaded window picks a live preview back up (else Rust takes an in-place one out after 30 s). */
export async function resumeLivePreview(): Promise<void> {
  const live = await commands.live().catch(() => null);
  if (!live || offeredChanges().some((o) => o.id === live.id)) return;
  offerChange({
    id: live.id,
    kind: HUB_CODE,
    title:
      live.delivery === "rebuild"
        ? "Your app change (preview is open in your browser)"
        : "Your app change (preview is on)",
    by: "A Mono",
    data: { id: live.id, delivery: live.delivery } satisfies ChangeData,
    previewing: true,
    ...deliveryText(live.delivery),
  });
  keepPinging(live.delivery !== "rebuild");
}
