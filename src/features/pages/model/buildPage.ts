import { HubCallError, tauriHubTransport, toHubError, type HubTransport } from "../../hub/model/hubTransport";
import { listMonos } from "../../monos/model/mono";
import { checkBespokePage, type DesignIssue } from "./designCheck";
import { validatePageSpec, type PageSpec } from "./pageSpec";
import { stubPageSpec } from "./stubPages";

/**
 * The seam between Pages and a real Mono build (docs/pages-build-contract.md). The app calls the backend through the
 * hub transport with `ash-hub-build-page`; the backend has the Mono build the page and answers with a PageSpec.
 * Only a seated Mono may build: temporary workers are turned away before anything is sent.
 */
export type BuildPageRequest = { projectId: string; monoId: string; prompt: string };
export type BuildPageResult =
  | { status: "ready"; spec: PageSpec; warnings: DesignIssue[]; /** The Mono asks for it to be pinned in the sidebar. */ pin?: boolean }
  | { status: "turned-down"; reason: string }
  | { status: "not-connected"; reason: string }
  | { status: "error"; reason: string };

export const BUILD_PAGE_ACTION = "ash-hub-build-page";
export const SEATED_ONLY_PAGES = "Only a seated Mono can build pages. Temporary workers can't.";
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

export async function buildPage(req: BuildPageRequest, deps: BuildDeps = {}): Promise<BuildPageResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY_PAGES };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what the page should show." };
  let raw: unknown;
  if (deps.stub ?? devStubOn()) raw = stubPageSpec(req.prompt);
  else {
    try {
      raw = await (deps.transport ?? tauriHubTransport).call(BUILD_PAGE_ACTION, { projectId: req.projectId, monoId: req.monoId, prompt: req.prompt });
    } catch (e) {
      const err = e instanceof HubCallError ? e : toHubError(e);
      if (err.isDown || err.kind === "refused") return { status: "not-connected", reason: "Building pages with a Mono isn't wired to the backend yet." };
      return { status: "error", reason: err.message || "The build didn't go through." };
    }
  }
  const pin = !!raw && typeof raw === "object" && (raw as { pin?: unknown }).pin === true ? { pin: true } : {};
  const spec = validatePageSpec(raw);
  if (!spec.ok) return { status: "turned-down", reason: spec.error };
  if (spec.value.kind === "blocks") return { status: "ready", spec: spec.value, warnings: [], ...pin };
  const check = checkBespokePage(spec.value);
  if (check.blocked) return { status: "turned-down", reason: check.blocked.plain };
  return { status: "ready", spec: spec.value, warnings: check.warnings, ...pin };
}
