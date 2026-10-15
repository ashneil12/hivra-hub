import { recordHubChange, setHubChangeHooks } from "../../hub/model/botChanges";
import { HubCallError, tauriHubTransport, toHubError, type HubTransport } from "../../hub/model/hubTransport";
import { isSeatedMono } from "../../pages/model/buildPage";

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

async function call<T>(action: string, payload: Record<string, unknown>, deps: ChangeDeps): Promise<T> {
  return (deps.transport ?? tauriHubTransport).call<T>(action, payload);
}
function notConnected(flow: ChangeFlow, e: unknown): ChangeResult {
  const err = e instanceof HubCallError ? e : toHubError(e);
  if (err.isDown || err.kind === "refused") return { status: "not-connected", reason: NOT_WIRED[flow] };
  return { status: "error", reason: err.message || "That didn't go through." };
}

export async function requestChange(req: ChangeRequest, deps: ChangeDeps = {}): Promise<ChangeResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what should change." };
  if (deps.stub ?? changeStubOn()) return { status: "ready", preview: stubPreview(req) };
  try {
    const raw = await call<unknown>(CHANGE_ACTIONS.preview, req, deps);
    const preview = validPreview(raw);
    return preview ? { status: "ready", preview } : { status: "turned-down", reason: "The preview build came back in a shape the hub can't show." };
  } catch (e) {
    return notConnected(req.flow, e);
  }
}

/** Apply: the backend swaps the preview build in; a Bot changes row with Undo is added. */
export async function applyChange(flow: ChangeFlow, p: ChangePreview, deps: ChangeDeps = {}): Promise<ChangeResult | { status: "applied" }> {
  try {
    if (!(deps.stub ?? changeStubOn())) await call(CHANGE_ACTIONS.apply, { previewId: p.previewId }, deps);
    recordHubChange(p.previewId, p.by, `${p.by} ${flow === "connect" ? "connected" : "changed"}: ${p.title}`, p.title);
    return { status: "applied" };
  } catch (e) {
    return notConnected(flow, e);
  }
}
export async function discardChange(p: ChangePreview, deps: ChangeDeps = {}): Promise<void> {
  if (deps.stub ?? changeStubOn()) return;
  await call(CHANGE_ACTIONS.discard, { previewId: p.previewId }, deps).catch(() => undefined);
}

setHubChangeHooks({
  undo: async (id) => { if (!changeStubOn()) await tauriHubTransport.call(CHANGE_ACTIONS.undo, { previewId: id }).catch((e) => { throw new Error(toHubError(e).isDown ? "Not connected yet, so nothing was undone." : toHubError(e).message); }); },
  redo: async (id) => { if (!changeStubOn()) await tauriHubTransport.call(CHANGE_ACTIONS.redo, { previewId: id }).catch((e) => { throw new Error(toHubError(e).isDown ? "Not connected yet, so nothing was redone." : toHubError(e).message); }); },
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
