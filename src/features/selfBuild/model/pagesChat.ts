import { useSyncExternalStore } from "react";
import { hubData } from "../../hub/model/hubData";
import { checkBuiltSpec } from "../../pages/model/buildPage";
import { findPage, keepPage, pageFromSpec, type Page } from "../../pages/model/pages";

/**
 * A Mono builds a Page from its own chat (ash-day step 14): it reads the real data itself, fills the hub's ready-made
 * blocks (`page_build {project, spec}`), and Ash sees the preview on Pages with Keep and Throw away, the same screen
 * a page built from the Pages prompt shows. After "looks good" the Mono keeps it (`page_build {previewId, keep}`), or
 * Ash taps Keep. Keeping leaves the Bot changes row with Undo (pages.ts).
 */
export type ChatPreview = { previewId: string; page: Page; monoId: string; at: number };

let previews: ChatPreview[] = [];
let version = 0;
const subs = new Set<() => void>();
const changed = () => {
  version++;
  subs.forEach((f) => f());
};

/** The newest preview still waiting, for the Pages screen. */
export function useChatPagePreview(): ChatPreview | undefined {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return previews[previews.length - 1];
}
export function chatPreview(id: string): ChatPreview | undefined {
  return previews.find((p) => p.previewId === id);
}
/** Ash taps See it: Pages opens on the preview. */
export function openChatPreview(id: string): void {
  if (!chatPreview(id)) return;
  previews = [...previews.filter((p) => p.previewId !== id), chatPreview(id)!];
  changed();
  window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "pages" }));
}
/** Kept or thrown away: off the Pages screen. */
export function settleChatPreview(id: string): void {
  previews = previews.filter((p) => p.previewId !== id);
  changed();
}

function projectOf(ref: unknown): { id: string; name: string } {
  if (ref === undefined) return { id: "today", name: "Today" };
  if (typeof ref !== "string" || !ref.trim()) throw new Error("project must be a hub project's id or name");
  const want = ref.trim().toLowerCase();
  const found = hubData().listProjects().find((p) => p.id.toLowerCase() === want || p.name.toLowerCase() === want);
  if (!found) throw new Error(`No hub project "${ref}". Projects: ${hubData().listProjects().map((p) => p.name).join(", ")}.`);
  return { id: found.id, name: found.name };
}

/** Check the Mono's spec and show it to Ash. Turned down in plain words when it doesn't fit. */
export function previewFromChat(input: Record<string, unknown>, by: { monoId: string; name: string }, now = Date.now()) {
  const project = projectOf(input.project);
  const result = checkBuiltSpec(input.spec);
  if (result.status !== "ready") throw new Error(`The page was turned down: ${"reason" in result ? result.reason : "it doesn't fit"}`);
  const request = typeof input.request === "string" && input.request.trim() ? input.request.trim().slice(0, 2000) : result.spec.title;
  const page = pageFromSpec(result.spec, request, by.name, project.id, result.warnings, now, undefined, by.monoId);
  const previewId = page.id;
  previews = [...previews.filter((p) => p.previewId !== previewId), { previewId, page, monoId: by.monoId, at: now }];
  changed();
  return {
    previewId,
    title: result.spec.title,
    project: project.name,
    ...(result.warnings.length ? { warnings: result.warnings.map((w) => w.plain) } : {}),
    note: "Ash sees it at the bottom of the window (See it opens the preview on Pages, with Keep and Throw away). Tell him in one line; after he says it looks good, call page_build with previewId and keep true.",
  };
}

/** Keep it on Ash's okay. A page Ash already kept or threw away says so. */
export async function keepFromChat(previewId: unknown, by: { monoId: string }, ashSpokeSince: (since: number) => boolean) {
  if (typeof previewId !== "string" || !previewId) throw new Error("previewId must be the id page_build gave you");
  const preview = chatPreview(previewId);
  if (!preview) {
    const kept = findPage(previewId);
    if (kept?.keptAt && !kept.removed) return { kept: kept.title, alreadyKept: true };
    throw new Error("That preview isn't waiting any more: Ash threw it away, or it was never made. Build it again if he wants it.");
  }
  if (preview.monoId !== by.monoId) throw new Error("That preview is another Mono's.");
  if (!ashSpokeSince(preview.at)) throw new Error("Ash hasn't answered since the preview. Wait for his okay.");
  const ok = await keepPage(preview.page);
  if (!ok) throw new Error("Pages couldn't save it just now. Ask Ash to tap Keep on the preview.");
  settleChatPreview(previewId);
  return { kept: preview.page.title, pageId: preview.page.id, note: "It's on the project's Pages, with Undo in Bot changes." };
}
