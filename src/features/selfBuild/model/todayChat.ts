import { useSyncExternalStore } from "react";
import { BUILD_RECHECK_MS, BUILD_TOTAL_SECONDS } from "../../pages/model/buildPage";
import { applyChange, discardChange, requestChange, type ChangeDeps, type ChangePreview, type ChangeResult } from "../../hubChange/model/hubChange";
import { forUser } from "../../hub/model/userName";

/**
 * Any Mono edits Today from its own chat (`today_change {ask}`): Ash OS builds the change as a preview (the same one
 * Pages > Edit Today builds), Ash sees Now beside Preview with Apply and Discard, and Apply leaves a Bot changes row
 * with Undo. It is data, not code: no worker, no hub_change.
 */
/** flow "today" for Today's sections; "hub" for the project order, which the Today cards (and the sidebar) follow. */
export type TodayChatPreview = { previewId: string; prompt: string; preview: ChangePreview; monoId: string; at: number; flow: "today" | "hub" };

let previews: TodayChatPreview[] = [];
let version = 0;
const subs = new Set<() => void>();
const changed = () => {
  version++;
  subs.forEach((f) => f());
};
let shown: string | undefined;
export function setTodayPreviewShown(id: string | undefined): void {
  if (shown === id) return;
  shown = id;
  changed();
}
export function todayPreviewShown(): string | undefined {
  return shown;
}
export function useTodayChatPreview(): TodayChatPreview | undefined {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return previews[previews.length - 1];
}
export function todayChatPreview(id: string): TodayChatPreview | undefined {
  return previews.find((p) => p.previewId === id);
}
/** See it: Pages opens on Edit Today with the preview. */
export const OPEN_EDIT_TODAY = "monocode:pages-tab";
/** Opened (See it) and not yet settled: Pages starts on Edit Today. */
let wanted: string | undefined;
export function todayPreviewWaiting(): "today" | "hub" | undefined {
  return wanted ? todayChatPreview(wanted)?.flow : undefined;
}
export function openTodayChatPreview(id: string): void {
  const p = todayChatPreview(id);
  if (!p) return;
  previews = [...previews.filter((x) => x.previewId !== id), p];
  wanted = id;
  changed();
  window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "pages" }));
  window.dispatchEvent(new CustomEvent(OPEN_EDIT_TODAY, { detail: p.flow }));
}
export function settleTodayChatPreview(id: string): void {
  if (wanted === id) wanted = undefined;
  previews = previews.filter((p) => p.previewId !== id);
  changed();
}

export type TodayDeps = ChangeDeps & { now?: () => number; sleep?: (ms: number) => Promise<void> };
function plain(r: Exclude<ChangeResult, { status: "ready" }>): string {
  if (r.status === "app-change") return `${r.reason} That one needs a code change: hand it to hub_change with Ash's words.`;
  return r.reason;
}

/** Build the preview and put it in front of Ash. Waits for a slow build (up to BUILD_TOTAL_SECONDS). */
export async function todayFromChat(input: Record<string, unknown>, me: { monoId: string; name: string }, deps: TodayDeps = {}) {
  if (typeof input.ask !== "string" || !input.ask.trim()) throw new Error(forUser("ask must be Ash's words for the change to Today"));
  const prompt = input.ask.trim().slice(0, 2000);
  if (input.projectOrder !== undefined && typeof input.projectOrder !== "boolean") throw new Error("projectOrder must be true or left out");
  let flow: "today" | "hub" = input.projectOrder === true ? "hub" : "today";
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + BUILD_TOTAL_SECONDS * 1000;
  const build = async (f: "today" | "hub") => {
    let r = await requestChange({ flow: f, projectId: "today", monoId: me.monoId, prompt }, deps);
    while (r.status === "building" && now() < end) {
      await sleep(BUILD_RECHECK_MS);
      r = await requestChange({ flow: f, projectId: "today", monoId: me.monoId, prompt }, deps);
    }
    return r;
  };
  let result = await build(flow);
  // Today's sections can't move a project card; the cards follow the project order (C7 live 22 Oct: Alfred left
  // projectOrder out). A turned-down Today change is tried once as that order change, still only a preview.
  if (flow === "today" && result.status === "turned-down") {
    const order = await build("hub");
    if (order.status === "ready") { result = order; flow = "hub"; }
  }
  if (result.status === "building") throw new Error(forUser("The preview is still building. Call today_change again with the same ask in a minute; it picks the same build up."));
  if (result.status !== "ready") throw new Error(plain(result));
  const p = result.preview;
  previews = [...previews.filter((x) => x.previewId !== p.previewId), { previewId: p.previewId, prompt, preview: p, monoId: me.monoId, at: now(), flow }];
  changed();
  return {
    previewId: p.previewId,
    title: p.title,
    note: forUser((flow === "hub" ? "The project order is the sidebar's too, so the preview shows both. " : "") + "Ash sees it at the bottom of the window (See it opens Now beside Preview on Hubs, with Apply and Discard; after Apply, Undo is in Bot changes). Tell him in one line; if he says yes in chat, call today_change with previewId and apply true."),
  };
}

/** Apply on Ash's yes in chat. */
export async function applyTodayFromChat(previewId: unknown, me: { monoId: string }, ashSpokeSince: (since: number) => boolean, deps: ChangeDeps = {}) {
  if (typeof previewId !== "string" || !previewId) throw new Error("previewId must be the id today_change gave you");
  const p = todayChatPreview(previewId);
  if (!p) throw new Error(forUser("That preview isn't waiting any more: Ash applied it or threw it away. Ask again if he wants it."));
  if (p.monoId !== me.monoId) throw new Error("That preview is another Mono's.");
  if (!ashSpokeSince(p.at)) throw new Error(forUser("Ash hasn't answered since the preview. Wait for his okay."));
  const done = await applyChange(p.flow, p.preview, deps);
  if (done.status !== "applied") throw new Error(done.status === "ready" ? "That didn't go through." : plain(done));
  settleTodayChatPreview(previewId);
  return { applied: p.preview.title, note: "It's on Today now, with Undo in Bot changes." };
}
export async function discardTodayChat(id: string, deps: ChangeDeps = {}): Promise<void> {
  const p = todayChatPreview(id);
  settleTodayChatPreview(id);
  if (p) await discardChange(p.preview, deps);
}
