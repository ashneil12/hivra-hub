import { recordHubChange, setHubChangeHooks, setHubChangeSource, type BotChange } from "../../hub/model/botChanges";
import { liveHubStore } from "../../hub/model/hubData";
import type { HubSlice } from "../../hub/model/hubStore";
import { HubCallError, tauriHubTransport, toHubError, type HubTransport } from "../../hub/model/hubTransport";
import { clearLocalProjectOrder } from "../../hub/model/projectPrefs";
import type { HubChangeRecord } from "../../hub/model/types";
import { BUILD_WAIT_SECONDS, isSeatedMono, isStillBuilding } from "../../pages/model/buildPage";

/**
 * The seam for Level 2 changes (docs/hub-change-contract.md): Change the hub, Edit Today by chat, and Connect data.
 * A seated Mono asks Claude Code for a preview build; Ash sees Now beside Preview, then Apply or Discard; Apply adds a
 * Bot changes row whose Undo reverts it. Every call goes through the hub transport; unwired ones say Not connected yet.
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
  | { status: "error"; reason: string };

export const CHANGE_ACTIONS = { preview: "ash-hub-change-preview", apply: "ash-hub-change-apply", discard: "ash-hub-change-discard", undo: "ash-hub-change-undo", redo: "ash-hub-change-redo" } as const;
export const SEATED_ONLY = "You ask, and one of your seated Monos builds it. Temporary workers can't.";
export const HUB_CANT = "This can't change keys or the Keychain, account sign-ins, delete projects or Monos, or skip the preview.";
export const FLOW_LABEL: Record<ChangeFlow, string> = { hub: "Change the hub", today: "Edit Today", connect: "Connect data" };
const NOT_WIRED: Record<ChangeFlow, string> = {
  hub: "Changing the hub with a preview build isn't wired to the backend yet.",
  today: "Editing Today by chat isn't wired to the backend yet.",
  connect: "Connecting your own data isn't wired to the backend yet.",
};
const DEV_STUB_KEY = "monocode:hub-change-dev-stub";
export function changeStubOn(): boolean {
  try {
    return localStorage.getItem(DEV_STUB_KEY) === "1";
  } catch {
    return false;
  }
}

export type ChangeDeps = { transport?: HubTransport; roster?: readonly { id: string }[]; stub?: boolean };
const NAMES: Record<string, string> = { "projects-manager": "Projects Manager", "chief-of-staff": "Chief of Staff" };

function validPreview(raw: unknown): ChangePreview | undefined {
  const x = raw as ChangePreview | undefined;
  const side = (s: ChangeSide | undefined) => !!s && Array.isArray(s.sections) && s.sections.every((sec) => typeof sec.title === "string" && Array.isArray(sec.rows));
  return x && typeof x.previewId === "string" && typeof x.title === "string" && side(x.now) && side(x.preview) ? x : undefined;
}

/** What an applied, undone or redone change can move: the sidebar, Today, and the history itself. */
const MOVES: readonly HubSlice[] = ["changes", "layout", "projects"];

/** Through the live store when there is one (the slices it moves are read again at once), else the given transport. */
async function call<T>(action: string, payload: Record<string, unknown>, deps: ChangeDeps, reload: readonly HubSlice[] = []): Promise<T> {
  const store = deps.transport ? undefined : liveHubStore();
  if (store) return store.act<T>(action, payload, reload);
  return (deps.transport ?? tauriHubTransport).call<T>(action, payload);
}
function notConnected(flow: ChangeFlow, e: unknown): ChangeResult {
  const err = e instanceof HubCallError ? e : toHubError(e);
  if (err.isDown || err.kind === "refused") return { status: "not-connected", reason: NOT_WIRED[flow] };
  if (err.kind === "timeout") return { status: "building", reason: "The preview is taking a while. Press Try again in a moment to see it." };
  if (isStillBuilding(err.message)) return { status: "building", reason: err.message };
  // Ash OS says "isn't wired" for Connect data before any Mono runs.
  if (/isn't wired/i.test(err.message)) return { status: "not-connected", reason: err.message };
  if (/turned it down|doesn't fit/i.test(err.message) || err.message === SEATED_ONLY) return { status: "turned-down", reason: err.message };
  return { status: "error", reason: err.message || "That didn't go through." };
}

export async function requestChange(req: ChangeRequest, deps: ChangeDeps = {}): Promise<ChangeResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what should change." };
  if (deps.stub ?? changeStubOn()) return { status: "ready", preview: stubPreview(req) };
  try {
    const raw = await call<unknown>(CHANGE_ACTIONS.preview, { ...req, wait: BUILD_WAIT_SECONDS }, deps, ["changes"]);
    const preview = validPreview(raw);
    return preview ? { status: "ready", preview } : { status: "turned-down", reason: "The preview build came back in a shape the hub can't show." };
  } catch (e) {
    return notConnected(req.flow, e);
  }
}

/**
 * Apply: Ash OS swaps the preview in (refused, with nothing written, if what it changes moved since). Its history
 * holds the change from then on, with Undo and Redo, in Bot changes and under the ask box.
 */
export async function applyChange(flow: ChangeFlow, p: ChangePreview, deps: ChangeDeps = {}): Promise<ChangeResult | { status: "applied" }> {
  try {
    const stub = deps.stub ?? changeStubOn();
    if (!stub) await call(CHANGE_ACTIONS.apply, { previewId: p.previewId }, deps, MOVES);
    if (flow === "hub") clearLocalProjectOrder(); // the sidebar's order is Ash OS's now
    // Without Ash OS's history (the dev stub, or a test's own transport) the row is kept here.
    if (stub || deps.transport || !liveHubStore()) recordHubChange(p.previewId, p.by, `${p.by} ${flow === "connect" ? "connected" : "changed"}: ${p.title}`, p.title);
    return { status: "applied" };
  } catch (e) {
    return notConnected(flow, e);
  }
}
export async function discardChange(p: ChangePreview, deps: ChangeDeps = {}): Promise<void> {
  if (deps.stub ?? changeStubOn()) return;
  await call(CHANGE_ACTIONS.discard, { previewId: p.previewId }, deps, ["changes"]).catch(() => undefined);
}

/** Undo or Redo an applied change (from the history, Today or Bot changes). Throws Ash OS's refusal in plain words. */
export async function undoChange(previewId: string, deps: ChangeDeps = {}): Promise<void> {
  await backAndForth(CHANGE_ACTIONS.undo, previewId, deps, "undone");
}
export async function redoChange(previewId: string, deps: ChangeDeps = {}): Promise<void> {
  await backAndForth(CHANGE_ACTIONS.redo, previewId, deps, "redone");
}
async function backAndForth(action: string, previewId: string, deps: ChangeDeps, what: string): Promise<void> {
  if (deps.stub ?? changeStubOn()) return;
  try {
    await call(action, { previewId }, deps, MOVES);
  } catch (e) {
    const err = toHubError(e);
    throw new Error(err.isDown ? `Not connected yet, so nothing was ${what}.` : err.message);
  }
}

setHubChangeHooks({ undo: (id) => undoChange(id), redo: (id) => redoChange(id) });

const FLOW_WORD: Record<ChangeFlow, string> = { hub: "the hub", today: "Today", connect: "a connection" };
/** "Projects Manager changed Today: Put “Sign-ups” on Today". */
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
/** The history's applied and undone changes as Bot changes rows (Ash OS's record is the source; nothing is kept here). */
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
  const by = NAMES[req.monoId] ?? req.monoId;
  const id = `example-${req.flow}-${Date.now().toString(36)}`;
  if (req.flow === "today")
    return { previewId: id, by, title: "Builds this week on Today",
      now: { sections: [{ title: "Needs you", rows: ["Example: Approve Q4 hiring plan", "Example: Pick the waitlist headline"] }] },
      preview: { sections: [{ title: "Needs you", rows: ["Example: Approve Q4 hiring plan", "Example: Pick the waitlist headline"] }, { title: "Builds this week", rows: ["Example: 15 across EXO, Hivra, Nibbii"] }] } };
  if (req.flow === "connect")
    return { previewId: id, by, title: "Bug tracker on the EXO page",
      now: { sections: [{ title: "Open bugs", rows: ["Example: Shader step fails on Intel Macs", "Example: Jump clips through the ledge"] }, { title: "Source", rows: ["Example data"] }] },
      preview: { sections: [{ title: "Open bugs", rows: ["Example: Shader step fails on Intel Macs", "Example: Jump clips through the ledge", "Example: Save slot shows wrong date"] }, { title: "Source", rows: ["Example: Bug tracker · read-only · last read 2 min ago"] }] } };
  return { previewId: id, by, title: "Pin the backup chat and group the rest by week",
    now: { sections: [{ title: "Conversations", rows: ["Example: Onboarding emails", "Example: Nightly backup plan", "Example: Pricing page copy"] }] },
    preview: { sections: [{ title: "Pinned", rows: ["Example: Nightly backup plan"] }, { title: "This week", rows: ["Example: Pricing page copy", "Example: Onboarding emails"] }] } };
}
