import { recordHubChange, setHubChangeHooks, setHubChangeSource, type BotChange } from "../../hub/model/botChanges";
import { liveHubStore } from "../../hub/model/hubData";
import { clearLocalProjectOrder } from "../../hub/model/projectPrefs";
import type { HubChangeRecord } from "../../hub/model/types";
import { isSeatedMono } from "../../pages/model/buildPage";

/**
 * The seam for Level 2 changes (docs/hub-change-contract.md): Change the hub, Edit Today by chat, and Connect data.
 * A seated Mono asks Claude Code for a preview build; Ash sees Now beside Preview, then Apply or Discard; Apply adds a
 * Bot changes row whose Undo reverts it. The preview builds ran in Ash OS, which is retired with the bridge (WP-04):
 * outside the dev stub every flow says Not connected, and self-build (its own local worktree flow) changes the app.
 */
export type ChangeFlow = "hub" | "today" | "connect";
export type ChangeRequest = { flow: ChangeFlow; projectId: string; monoId: string; prompt: string };
/** One side of the comparison: what the backend's preview build shows, as sections of rows (and optionally an image). */
export type ChangeSide = { image?: string; sections: { title: string; rows: string[] }[] };
export type ChangePreview = { previewId: string; title: string; by: string; now: ChangeSide; preview: ChangeSide };
export type ChangeResult =
  | { status: "ready"; preview: ChangePreview }
  | { status: "turned-down"; reason: string }
  | { status: "not-connected"; reason: string }
  /** The Mono is still building the preview: Try again collects it (the same request never builds twice). */
  | { status: "building"; reason: string }
  /** It changes the app itself (a screen's look or behaviour): the MonoCode Hub lead's work (appChange.ts). */
  | { status: "app-change"; reason: string }
  | { status: "error"; reason: string };

export const SEATED_ONLY = "You ask, and one of your own Monos builds it. Temporary workers can't.";
export const HUB_CANT = "This can't change keys or the Keychain, account sign-ins, delete projects or Monos, or skip the preview.";
export const FLOW_LABEL: Record<ChangeFlow, string> = { hub: "Change the app", today: "Edit Today", connect: "Connect data" };
const NOT_WIRED: Record<ChangeFlow, string> = {
  hub: "Changing the app with a preview build isn't wired up. Ask the MonoCode Hub lead to change the app instead.",
  today: "Editing Today by chat isn't wired up.",
  connect: "Connecting your own data isn't wired up.",
};
const DEV_STUB_KEY = "monocode:hub-change-dev-stub";
export function changeStubOn(): boolean {
  try {
    return localStorage.getItem(DEV_STUB_KEY) === "1";
  } catch {
    return false;
  }
}

export type ChangeDeps = { roster?: readonly { id: string }[]; stub?: boolean };
/** Dev stub only: words that ask for a screen's look or behaviour. */
const STUB_SCREEN = /\b(bigger|smaller|colou?r|font|rounder|button|screen|dark mode|look)\b/i;

export async function requestChange(req: ChangeRequest, deps: ChangeDeps = {}): Promise<ChangeResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what should change." };
  if (deps.stub ?? changeStubOn()) {
    if (req.flow !== "connect" && STUB_SCREEN.test(req.prompt))
      return { status: "app-change", reason: `${req.monoId} says this is a change to the app itself: Example: that's how a screen looks.` };
    return { status: "ready", preview: stubPreview(req) };
  }
  return { status: "not-connected", reason: NOT_WIRED[req.flow] };
}

/** Apply a dev-stub preview: the row is kept here, in Bot changes. Outside the stub nothing is ever ready to apply. */
export async function applyChange(flow: ChangeFlow, p: ChangePreview, deps: ChangeDeps = {}): Promise<ChangeResult | { status: "applied" }> {
  if (!(deps.stub ?? changeStubOn())) return { status: "not-connected", reason: NOT_WIRED[flow] };
  if (flow === "hub") clearLocalProjectOrder();
  recordHubChange(p.previewId, p.by, `${p.by} ${flow === "connect" ? "connected" : "changed"}: ${p.title}`, p.title);
  return { status: "applied" };
}
export async function discardChange(_p: ChangePreview, _deps: ChangeDeps = {}): Promise<void> {}

/** Undo or Redo an applied change from Bot changes. Only dev-stub changes exist now; they are undone there. */
export async function undoChange(_previewId: string, _deps: ChangeDeps = {}): Promise<void> {}
export async function redoChange(_previewId: string, _deps: ChangeDeps = {}): Promise<void> {}

setHubChangeHooks({ undo: (id) => undoChange(id), redo: (id) => redoChange(id) });

const FLOW_WORD: Record<ChangeFlow, string> = { hub: "the app", today: "Today", connect: "a connection" };
/** "<who> changed Today: Put “Sign-ups” on Today". `by` is the Mono that asked. */
export function changeLine(c: Pick<HubChangeRecord, "by" | "flow" | "title">): string {
  return `${c.by} changed ${FLOW_WORD[c.flow]}: ${c.title}`;
}
function dayOf(iso: string | undefined, now = new Date()): string {
  if (!iso) return "Today";
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
/** A history's applied and undone changes as Bot changes rows (none since Ash OS's history was retired). */
export function hubChangeRows(changes: readonly HubChangeRecord[]): BotChange[] {
  return changes
    .filter((c) => c.state === "applied" || c.state === "undone")
    .map((c) => ({
      id: `hub:${c.previewId}`, bot: c.by, day: dayOf(c.appliedAt ?? c.createdAt), line: changeLine(c), now: "As it was", after: c.title,
      hubChangeId: c.previewId, ...(c.state === "undone" ? { undone: true } : {}),
    }));
}
setHubChangeSource(() => {
  const changes = liveHubStore()?.getSnapshot().changes;
  return changes ? hubChangeRows(changes) : undefined;
});

/** Dev only: example previews for each flow, every made-up row labelled Example:. */
export function stubPreview(req: ChangeRequest): ChangePreview {
  const by = req.monoId;
  const id = `example-${req.flow}-${Date.now().toString(36)}`;
  if (req.flow === "today")
    return { previewId: id, by, title: "Builds this week on Today",
      now: { sections: [{ title: "Needs you", rows: ["Example: Approve Q4 hiring plan", "Example: Pick the waitlist headline"] }] },
      preview: { sections: [{ title: "Needs you", rows: ["Example: Approve Q4 hiring plan", "Example: Pick the waitlist headline"] }, { title: "Builds this week", rows: ["Example: 15 across EXO, Hivra, Nibbii"] }] } };
  if (req.flow === "connect")
    return { previewId: id, by, title: "Bug tracker on the EXO hub",
      now: { sections: [{ title: "Open bugs", rows: ["Example: Shader step fails on Intel Macs", "Example: Jump clips through the ledge"] }, { title: "Source", rows: ["Example data"] }] },
      preview: { sections: [{ title: "Open bugs", rows: ["Example: Shader step fails on Intel Macs", "Example: Jump clips through the ledge", "Example: Save slot shows wrong date"] }, { title: "Source", rows: ["Example: Bug tracker · read-only · last read 2 min ago"] }] } };
  return { previewId: id, by, title: "Pin the backup chat and group the rest by week",
    now: { sections: [{ title: "Conversations", rows: ["Example: Onboarding emails", "Example: Nightly backup plan", "Example: Pricing page copy"] }] },
    preview: { sections: [{ title: "Pinned", rows: ["Example: Nightly backup plan"] }, { title: "This week", rows: ["Example: Pricing page copy", "Example: Onboarding emails"] }] } };
}
