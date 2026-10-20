// "Editing the interface" (Ash 20 Oct: "i can edit parts of the interface that i like"). Change the hub moves what is in
// the hub (the sidebar's order, names and shapes, Today's sections): data Ash OS owns, previewed and undoable. How a screen
// looks or works is the app's own code, so it is the MonoCode Hub lead's work: MonoCode works on MonoCode (a worktree, a
// dev copy Ash tries, then Ship). When the Mono says a request is that, Change the hub explains it and, on Ash's tap,
// puts his words in that Lead's own chat through the composer's send (the same hands a page's message uses).
import { LEADS, leadMono } from "../../hub/model/hubLeads";
import { findMono, type Mono } from "../../monos/model/mono";
import { pageActionsHost } from "../../pages/model/pageActions";
import { agentName } from "../../pages/model/pageData";

export const HUB_PROJECT = "hub";
export const APP_CHANGE_NOTE =
  "To change how a screen looks or works, ask here too: it goes to the MonoCode Hub lead, who builds it in a copy of the app for you to try, then ships it when you say so.";
export const APP_CHANGE_WHY =
  "Change the hub moves what's in your hub: the sidebar's order, names and shapes, and what's on Today. How a screen looks or works is the app's own code, so it goes to the MonoCode Hub lead. It makes the change in its own copy of the app, you try that copy, and it ships when you say so.";
/** Ash OS's words for it: "<Mono> says this is a change to the app itself: <why>". */
export function isAppChange(message: string): boolean {
  return /\bis a change to the app itself\b/i.test(message);
}

/** The MonoCode Hub project's Lead today (its own seat, or the old Harness lead's it adopted). */
export function hubLeadMono(): Mono | undefined {
  const spec = LEADS.find((l) => l.projectId === HUB_PROJECT);
  return spec ? leadMono(spec) : undefined;
}

/** What the Lead is told: Ash's words, and how MonoCode changes itself. */
export function appChangeBrief(prompt: string): string {
  return [
    `Ash asked in Change the hub: “${prompt.trim()}”`,
    "That changes the app itself (a screen's look or behaviour), so it's yours: make it in a worktree, show Ash a dev copy of the app to try, and Ship it when he says so.",
    "",
    "(sent from Change the hub)",
  ].join("\n");
}

export type SendResult = { ok: true; lead: string } | { ok: false; reason: string };

/** Ash's tap on "Send to MonoCode Hub lead". A Lead with no chat yet is opened first, and the words follow once it has one. */
export async function sendToHubLead(prompt: string, opts: { waitMs?: number } = {}): Promise<SendResult> {
  const lead = hubLeadMono();
  if (!lead) return { ok: false, reason: "The MonoCode Hub lead isn't on your Monos list yet." };
  const name = agentName(lead);
  const hands = pageActionsHost();
  if (!hands) return { ok: false, reason: "The app isn't ready to send that yet. Open the MonoCode Hub lead and ask there." };
  let chat = lead.sessionId;
  if (!chat) {
    hands.openMono(lead.id);
    const end = Date.now() + (opts.waitMs ?? 4000);
    while (!chat && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
      chat = findMono(lead.id)?.sessionId;
    }
    if (!chat) return { ok: false, reason: `${name} is opening. Ask there in your own words.` };
  }
  const sent = await hands.send(chat, appChangeBrief(prompt)).catch(() => false);
  return sent ? { ok: true, lead: name } : { ok: false, reason: `${name} couldn't take a message right now. Open it and ask there.` };
}

/** Open the Lead's chat (after sending, or to ask in his own words). */
export function openHubLead(): void {
  const lead = hubLeadMono();
  if (lead) pageActionsHost()?.openMono(lead.id);
}
