import { liveHubStore } from "../../hub/model/hubData";
import { HubCallError, tauriHubTransport, toHubError, type HubTransport } from "../../hub/model/hubTransport";
import { listMonos } from "../../monos/model/mono";
import { checkBespokePage, type DesignIssue } from "./designCheck";
import { validatePageSpec, type PageSpec } from "./pageSpec";
import { stubPageSpec, stubRebuildSpec } from "./stubPages";

/**
 * The seam between Pages and a real Mono build (docs/pages-build-contract.md). The app calls Ash OS through the hub
 * transport with `ash-hub-build-page`; Ash OS runs that Mono on the project's real asks and answers with a PageSpec
 * (plus the record's `pageId`). Only a seated Mono may build: temporary workers are turned away before anything is sent.
 *
 * A build can take longer than one call: the app says how long Ash OS may wait (`wait`, which also stretches the
 * call's own time limit in hub.rs). If the Mono isn't done by then, the answer is "still building", and the same
 * request (Try again) joins the running build or collects the finished page; nothing is built twice.
 */
export type BuildPageRequest = { projectId: string; monoId: string; prompt: string };
/** Rebuild: a kept page changed from Ash's words; `current` is its spec (the dev stub changes it here). */
export type RebuildPageRequest = { pageId: string; monoId: string; prompt: string; current?: PageSpec };
export type BuildPageResult =
  | {
      status: "ready";
      spec: PageSpec;
      warnings: DesignIssue[];
      /** The Mono asks for it to be pinned in the sidebar. */
      pin?: boolean;
      /** Ash OS's id for this page (its preview is already in the record; Keep marks it kept). */
      pageId?: string;
      /** A rebuild: the kept page this new version would replace. */
      replaces?: string;
    }
  | { status: "turned-down"; reason: string }
  | { status: "not-connected"; reason: string }
  /** The Mono is still at it: Try again collects the page (the same request never starts a second build). */
  | { status: "building"; reason: string }
  | { status: "error"; reason: string };

/** How long Ash OS may wait for a build within one call (it allows up to 40 s; hub.rs adds this to its 15 s). */
export const BUILD_WAIT_SECONDS = 30;
/** Ash OS's "<Mono> is still building this page/preview. Press Try again…": a wait, not a failure. */
export function isStillBuilding(message: string): boolean {
  return /\bis still building\b/i.test(message);
}

export const BUILD_PAGE_ACTION = "ash-hub-build-page";
export const SEATED_ONLY_PAGES = "Only one of your own Monos can build pages. Temporary workers can't.";
const DEV_STUB_KEY = "monocode:pages-dev-stub";

/** Seated = on the Monos roster (CoS, PM, frank, Alfred, Leads, anything Ash added). Temporary workers never are. */
export function isSeatedMono(monoId: string, roster: readonly { id: string }[] = listMonos()): boolean {
  return roster.some((m) => m.id === monoId);
}
/** The old keyword stub, for development only: localStorage "monocode:pages-dev-stub" = "1". */
export function devStubOn(): boolean {
  try {
    return localStorage.getItem(DEV_STUB_KEY) === "1";
  } catch {
    return false;
  }
}

export type BuildDeps = { transport?: HubTransport; roster?: readonly { id: string }[]; stub?: boolean };

/**
 * No cap on how many pages build at once (H8, Ash 21 Oct 20:40: "if you build a page, you build a page ... Why does it
 * need a cap?"). The "3 at once" was only ever a proposed call and was never built here: each build is its own call to
 * Ash OS, nothing queues them, and buildPage.parallel.test.ts keeps it that way.
 */
export async function buildPage(req: BuildPageRequest, deps: BuildDeps = {}): Promise<BuildPageResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY_PAGES };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what the page should show." };
  return build({ projectId: req.projectId, monoId: req.monoId, prompt: req.prompt }, () => stubPageSpec(req.prompt), deps);
}

/**
 * Rebuild a kept page from Ash's words (Ash OS: `ash-hub-build-page` with its `pageId`). The answer is the page's new
 * version: it waits on the page (`newVersion`) until Ash uses it or throws it away; the page runs as it was until then.
 */
export async function rebuildPage(req: RebuildPageRequest, deps: BuildDeps = {}): Promise<BuildPageResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY_PAGES };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what should change on the page." };
  return build({ pageId: req.pageId, monoId: req.monoId, prompt: req.prompt }, () => (req.current ? stubRebuildSpec(req.current, req.prompt) : stubPageSpec(req.prompt)), deps);
}

async function build(payload: Record<string, unknown>, stub: () => unknown, deps: BuildDeps): Promise<BuildPageResult> {
  let raw: unknown;
  if (deps.stub ?? devStubOn()) raw = stub();
  else {
    try {
      const body = { ...payload, wait: BUILD_WAIT_SECONDS };
      const store = deps.transport ? undefined : liveHubStore();
      raw = store ? await store.act(BUILD_PAGE_ACTION, body, payload.pageId ? ["pages"] : []) : await (deps.transport ?? tauriHubTransport).call(BUILD_PAGE_ACTION, body);
    } catch (e) {
      const err = e instanceof HubCallError ? e : toHubError(e);
      if (err.kind === "error" && isStillBuilding(err.message)) return { status: "building", reason: err.message };
      if (err.kind === "timeout") return { status: "building", reason: "The page is taking a while. Press Try again in a moment to see it." };
      if (err.isDown || err.kind === "refused") return { status: "not-connected", reason: err.isDown ? "The harness service isn't running, so no Mono can build a page right now." : err.message };
      if (/turned it down/i.test(err.message) || err.message === SEATED_ONLY_PAGES) return { status: "turned-down", reason: err.message };
      // Ash OS's own words for it still say "seated" (r27c): shown in the app's plain words instead.
      if (/only a seated mono/i.test(err.message)) return { status: "turned-down", reason: SEATED_ONLY_PAGES };
      return { status: "error", reason: err.message || "The build didn't go through." };
    }
  }
  return checkBuiltSpec(raw);
}

/** A built page as it came back (from Ash OS, or from a Mono's own chat through page_build): checked, then ready. */
/** Why a real page with made-up data is turned down: real data, or an honest empty block. */
export const REAL_DATA_ONLY =
  "Use the project's real data (its board, commits, tickets or memory), or leave the block empty: an empty block shows 'Nothing here yet'. No example or made-up numbers.";

/** A spec the Mono filled with example data (the old "Example:" label, or sample/placeholder text). */
export function hasMadeUpData(spec: unknown): boolean {
  if (!spec || typeof spec !== "object" || (spec as { kind?: unknown }).kind !== "blocks") return false;
  return /\bExample:|\b(lorem ipsum|placeholder data|sample data|dummy data)\b/i.test(JSON.stringify((spec as { blocks?: unknown }).blocks ?? []));
}

/** `real`: a Mono's page_build from chat, where made-up data is turned down (Ash OS's build path relays what it gets). */
export function checkBuiltSpec(raw: unknown, options: { real?: boolean } = {}): BuildPageResult {
  const r = raw && typeof raw === "object" ? (raw as { pin?: unknown; pageId?: unknown; replaces?: unknown }) : {};
  const extra = {
    ...(r.pin === true ? { pin: true } : {}),
    ...(typeof r.pageId === "string" && r.pageId ? { pageId: r.pageId } : {}),
    ...(typeof r.replaces === "string" && r.replaces ? { replaces: r.replaces } : {}),
  };
  const spec = validatePageSpec(raw);
  if (!spec.ok) return { status: "turned-down", reason: spec.error };
  if (options.real && hasMadeUpData(spec.value)) return { status: "turned-down", reason: REAL_DATA_ONLY };
  if (spec.value.kind === "blocks") return { status: "ready", spec: spec.value, warnings: [], ...extra };
  const check = checkBespokePage(spec.value);
  if (check.blocked) return { status: "turned-down", reason: check.blocked.plain };
  return { status: "ready", spec: spec.value, warnings: check.warnings, ...extra };
}
