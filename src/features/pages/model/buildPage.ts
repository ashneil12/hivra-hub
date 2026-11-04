import { listMonos } from "../../monos/model/mono";
import { checkBespokePage, type DesignIssue } from "./designCheck";
import { validatePageSpec, type PageSpec } from "./pageSpec";
import { stubPageSpec, stubRebuildSpec } from "./stubPages";

/**
 * The seam between Pages and a Mono build (docs/pages-build-contract.md). Building a page through Ash OS is retired
 * with the bridge (WP-04): a Mono builds a page from its own chat (page_build), and WP-33 turns Pages into panel
 * plugins. Here the Build and Change buttons say so; the old keyword stub still answers behind its dev flag. Only a
 * seated Mono may build: temporary workers are turned away before anything else.
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

/**
 * How long the app keeps collecting one build before it shows "still building" (C3 live 22 Oct: a real page took
 * longer than one 30 s call and needed Try again). While the Mono is at it the app asks again by itself, the same
 * request joining the same build, so Ash never has to press Try again for an ordinary build.
 */
export const BUILD_TOTAL_SECONDS = 240;
/** The pause between two collecting calls. */
export const BUILD_RECHECK_MS = 2_000;
/** "<Mono> is still building this page/preview. Press Try again…": a wait, not a failure. */
export function isStillBuilding(message: string): boolean {
  return /\bis still building\b/i.test(message);
}

/** What the Build button says now that Ash OS doesn't build pages. */
export const BUILD_MOVED = "Ask the Mono in its chat to build this page: pages aren't built from here any more.";
export const SEATED_ONLY_PAGES = "Only one of your own Monos can build pages. Temporary workers can't.";
const DEV_STUB_KEY = "monocode:pages-dev-stub";

/** Seated = on the Monos roster (CoS, PM, ed, Alfred, Leads, anything Ash added). Temporary workers never are. */
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

export type BuildDeps = {
  roster?: readonly { id: string }[];
  stub?: boolean;
  /** Tests: the clock and the pause between collecting calls. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * No cap on how many pages build at once (H8, Ash 21 Oct 20:40: "if you build a page, you build a page ... Why does it
 * need a cap?"). The "3 at once" was only ever a proposed call and was never built here: each build is its own call,
 * nothing queues them, and buildPage.parallel.test.ts keeps it that way.
 */
export async function buildPage(req: BuildPageRequest, deps: BuildDeps = {}): Promise<BuildPageResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY_PAGES };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what the page should show." };
  return build({ projectId: req.projectId, monoId: req.monoId, prompt: req.prompt }, () => stubPageSpec(req.prompt), deps);
}

/**
 * Rebuild a kept page from Ash's words (with its `pageId`). The answer is the page's new
 * version: it waits on the page (`newVersion`) until Ash uses it or throws it away; the page runs as it was until then.
 */
export async function rebuildPage(req: RebuildPageRequest, deps: BuildDeps = {}): Promise<BuildPageResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY_PAGES };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what should change on the page." };
  return build({ pageId: req.pageId, monoId: req.monoId, prompt: req.prompt }, () => (req.current ? stubRebuildSpec(req.current, req.prompt) : stubPageSpec(req.prompt)), deps);
}

async function build(payload: Record<string, unknown>, stub: () => unknown, deps: BuildDeps): Promise<BuildPageResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + BUILD_TOTAL_SECONDS * 1000;
  for (;;) {
    const result = await buildOnce(payload, stub, deps);
    // Still building: ask again (the same request collects the same build) until it is ready or the total wait is up.
    if (result.status !== "building" || now() + BUILD_RECHECK_MS >= end) return result;
    await sleep(BUILD_RECHECK_MS);
  }
}

async function buildOnce(_payload: Record<string, unknown>, stub: () => unknown, deps: BuildDeps): Promise<BuildPageResult> {
  if (!(deps.stub ?? devStubOn())) return { status: "not-connected", reason: BUILD_MOVED };
  return checkBuiltSpec(stub());
}

/** A built page as it came back (from a Mono's own chat through page_build): checked, then ready. */
/** Why a real page with made-up data is turned down: real data, or an honest empty block. */
export const REAL_DATA_ONLY =
  "Use the project's real data (its board, commits, tickets or memory), or leave the block empty: an empty block shows 'Nothing here yet'. No example or made-up numbers.";

/** A spec the Mono filled with example data (the old "Example:" label, or sample/placeholder text). */
export function hasMadeUpData(spec: unknown): boolean {
  if (!spec || typeof spec !== "object" || (spec as { kind?: unknown }).kind !== "blocks") return false;
  return /\bExample:|\b(lorem ipsum|placeholder data|sample data|dummy data)\b/i.test(JSON.stringify((spec as { blocks?: unknown }).blocks ?? []));
}

/** `real`: a Mono's page_build from chat, where made-up data is turned down. */
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
