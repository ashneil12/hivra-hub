import { useSyncExternalStore } from "react";
import { hubData } from "../../hub/model/hubData";
import { checkBuiltSpec } from "../../pages/model/buildPage";
import { findPage, keepPage, pageFromSpec, type Page } from "../../pages/model/pages";
import { forUser } from "../../hub/model/userName";
import { answerPageAsk, pageAskFor } from "./pageAsks";

/**
 * A Mono builds a Page from its own chat (ash-day step 14): it reads the real data itself, fills the hub's ready-made
 * blocks (`page_build {project, spec}`), and Ash sees the preview on Pages with Apply and Discard, the same screen
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

/** The preview the Pages screen is showing right now, if any: the bar's See it hides then (Ash is already on it). */
let shown: string | undefined;
export function setChatPreviewShown(id: string | undefined): void {
  if (shown === id) return;
  shown = id;
  changed();
}
export function chatPreviewShown(): string | undefined {
  return shown;
}

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

/** What Pages calls a page with no project (PagesView's meta line), so a Mono says what Ash sees. */
export const NO_PROJECT = "Not tied to a project";
/** Where a kept page is, in the words of the screen it is on. */
export function pagePlace(projectName: string): string {
  return projectName === NO_PROJECT ? "Hubs (not tied to a project)" : `${projectName}'s Hubs`;
}

function projectOf(ref: unknown): { id: string; name: string } {
  // r61 (PM's blind C3): this said "Today", so a Mono told Ash the preview was "on Today", and there is no Today page.
  // The page's id stays "today" (where it is stored); its name is what Pages shows for it.
  if (ref === undefined) return { id: "today", name: NO_PROJECT };
  if (typeof ref !== "string" || !ref.trim()) throw new Error("project must be a project's id or name");
  const want = ref.trim().toLowerCase();
  const found = hubData().listProjects().find((p) => p.id.toLowerCase() === want || p.name.toLowerCase() === want);
  if (!found) throw new Error(`No project "${ref}". Projects: ${hubData().listProjects().map((p) => p.name).join(", ")}.`);
  return { id: found.id, name: found.name };
}

/**
 * Check the Mono's spec and show it to Ash. Turned down in plain words when it doesn't fit. When Ash asked for it on
 * the Pages card (G15, pageAsks.ts), it answers that ask: a new page is the same preview, shown on the card; a change is
 * a new version of the kept page, waiting on that page.
 */
export function previewFromChat(input: Record<string, unknown>, by: { monoId: string; name: string }, now = Date.now()) {
  const ask = pageAskFor(by.monoId, now);
  const result = checkBuiltSpec(input.spec, { real: true });
  if (result.status !== "ready") throw new Error(`The hub was turned down: ${"reason" in result ? result.reason : "it doesn't fit"}`);
  const request = typeof input.request === "string" && input.request.trim() ? input.request.trim().slice(0, 2000) : result.spec.title;
  const warnings = result.warnings.length ? { warnings: result.warnings.map((w) => w.plain) } : {};
  if (ask?.change) {
    answerPageAsk(by.monoId, { spec: result.spec, warnings: result.warnings, request, by: by.name }, now);
    return {
      title: result.spec.title,
      where: `A new version of “${ask.change.title}”, waiting on that hub on Hubs`,
      ...warnings,
      note: forUser("Ash sees it on that hub with Use this version and Discard; the hub stays as it is until he uses it. Tell him in one line it's there. Don't call keep: this is a new version of his hub, not a new hub."),
    };
  }
  // The card's ask names its project; a page_build that leaves it out is still for that project.
  const project = projectOf(input.project === undefined ? ask?.projectId : input.project);
  const page = pageFromSpec(result.spec, request, by.name, project.id, result.warnings, now, undefined, by.monoId);
  const previewId = page.id;
  previews = [...previews.filter((p) => p.previewId !== previewId), { previewId, page, monoId: by.monoId, at: now }];
  changed();
  if (ask) answerPageAsk(by.monoId, { spec: result.spec, warnings: result.warnings, request, by: by.name, previewId }, now);
  return {
    previewId,
    title: result.spec.title,
    project: project.name,
    where: `A preview on ${pagePlace(project.name)}`,
    ...warnings,
    note: ask
      ? forUser("Ash asked for it on the Hubs card and sees the preview there, with Apply and Discard. Tell him in one line it's ready, naming where it is as `where` says (there is no Today hub); after he says it looks good, call page_build with previewId and keep true.")
      : forUser("Ash sees it at the bottom of the window (See it opens the preview on Hubs, with Apply and Discard). Tell him in one line, naming where it is as `where` says (there is no Today hub); after he says it looks good, call page_build with previewId and keep true."),
  };
}

/** Keep it on Ash's okay. A page Ash already kept or threw away says so. */
export async function keepFromChat(previewId: unknown, by: { monoId: string }, ashSpokeSince: (since: number) => boolean) {
  if (typeof previewId !== "string" || !previewId) throw new Error("previewId must be the id page_build gave you");
  const preview = chatPreview(previewId);
  if (!preview) {
    const kept = findPage(previewId);
    if (kept?.keptAt && !kept.removed) return { kept: kept.title, alreadyKept: true };
    throw new Error(forUser("That preview isn't waiting any more: Ash threw it away, or it was never made. Build it again if he wants it."));
  }
  if (preview.monoId !== by.monoId) throw new Error("That preview is another Mono's.");
  if (!ashSpokeSince(preview.at)) throw new Error(forUser("Ash hasn't answered since the preview. Wait for his okay."));
  const ok = await keepPage(preview.page);
  if (!ok) throw new Error(forUser("Hubs couldn't save it just now. Ask Ash to tap Keep on the preview."));
  settleChatPreview(previewId);
  const where = preview.page.projectId && preview.page.projectId !== "today"
    ? pagePlace(hubData().listProjects().find((p) => p.id === preview.page.projectId)?.name ?? preview.page.projectId)
    : pagePlace(NO_PROJECT);
  return { kept: preview.page.title, pageId: preview.page.id, note: `It's on ${where}, with Undo in Bot changes. There is no Today hub; never say it is on Today.` };
}
