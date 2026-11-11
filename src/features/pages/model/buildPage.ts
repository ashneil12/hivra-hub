import { latestExchange } from "../../home/model/exchange";
import { monoChatHost, type HomeChiefHost } from "../../home/model/homeChief";
import { hubData } from "../../hub/model/hubData";
import { listMonos } from "../../monos/model/mono";
import { closePageAsk, openPageAsk, type PageAsk, type PageAskAnswer } from "../../selfBuild/model/pageAsks";
import { checkBespokePage, type DesignIssue } from "./designCheck";
import { validatePageSpec, type PageSpec } from "./pageSpec";
import { stubPageSpec, stubRebuildSpec } from "./stubPages";

/**
 * The seam between Pages and a first mate's build (G15). New page and Change send Ash's words to the chosen first
 * mate's own chat as a page build ask, and its page_build there (selfBuild/model/pagesChat.ts) comes back to the card:
 * the card on Pages and the chat are one path. The card waits a bounded time and says plainly when the first mate is
 * busy, has no chat, or answers without a page. The old keyword stub still answers behind its dev flag (the browser
 * preview). Only a seated Mono may build: temporary workers are turned away before anything else.
 */
export type BuildPageRequest = { projectId: string; monoId: string; prompt: string };
/** Rebuild: a kept page changed from Ash's words; `current` is its spec as it is now, sent with the ask. */
export type RebuildPageRequest = { pageId: string; monoId: string; prompt: string; current?: PageSpec; projectId?: string };
export type BuildPageResult =
  | {
      status: "ready";
      spec: PageSpec;
      warnings: DesignIssue[];
      /** The Mono asks for it to be pinned in the sidebar. */
      pin?: boolean;
      /** The record's id for this page (its preview is already in the record; Keep marks it kept). */
      pageId?: string;
      /** A rebuild: the kept page this new version would replace. */
      replaces?: string;
      /** A new page from the first mate's chat: its chat preview (pagesChat.ts), so Keep or Discard settles it. */
      previewId?: string;
    }
  | { status: "turned-down"; reason: string }
  /** The first mate is in the middle of a turn, or waits on Ash's answer: nothing was sent. */
  | { status: "busy"; reason: string }
  /** Asked, but no page came back: its turn ended without one, it asked something back, or the wait ran out. */
  | { status: "no-page"; reason: string }
  | { status: "error"; reason: string };

/**
 * How long the card waits for the first mate's page_build (C3 live 22 Oct: a real page took longer than one 30 s
 * call). Past it the card says so with Try again; a page that comes later still lands on Pages.
 */
export const BUILD_TOTAL_SECONDS = 240;
/** The pause between two looks at the first mate's chat. */
export const BUILD_RECHECK_MS = 2_000;

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

/** A first mate's own chat as the app lends it (Home's host, set in App.tsx). */
export type PageChatHost = Pick<HomeChiefHost, "ensure" | "submit" | "read">;

export type BuildDeps = {
  roster?: readonly { id: string; name?: string }[];
  stub?: boolean;
  /** Tests: the first mates' chats (null: none reachable). Left out, the app's own. */
  chat?: PageChatHost | null;
  /** Tests: the clock and the pause between looks. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function projectName(projectId: string | undefined): string | undefined {
  return projectId ? hubData().listProjects().find((p) => p.id === projectId)?.name : undefined;
}

/** What New page sends to the first mate's chat, in Ash's voice (it shows there as his message). */
export function newPageAsk(prompt: string, project?: string): string {
  const where = project ? `project "${project}"` : "no project (it isn't tied to one)";
  return [
    `From Pages: build me a new page. “${prompt.trim()}”`,
    "",
    `Use page_build with ${where}, request set to my words above, and a spec filled only with real data you read first. I'm waiting on the Pages card for the preview, so answer with page_build. If you can't build it, tell me why in one line.`,
  ].join("\n");
}

/** What Change sends: the ask and the kept page as it is now. */
export function changePageAsk(prompt: string, title: string, current: PageSpec | undefined, project?: string): string {
  const where = project ? `project "${project}"` : "no project";
  return [
    `From Pages: change my page “${title}”. “${prompt.trim()}”`,
    ...(current ? ["", "Here is the page as it is now (its PageSpec):", "```json", JSON.stringify(current, null, 2), "```"] : []),
    "",
    `Use page_build with ${where}, request set to my words above, and the whole page with the change made: keep everything I didn't ask to change, real data only. It comes back to that page as a new version for me to use or discard, so don't call keep. If you can't make the change, tell me why in one line.`,
  ].join("\n");
}

/**
 * No cap on how many pages build at once (H8, Ash 21 Oct 20:40: "if you build a page, you build a page ... Why does it
 * need a cap?"): each build is its own ask to its own first mate, nothing queues them, and buildPage.parallel.test.ts
 * keeps it that way.
 */
export async function buildPage(req: BuildPageRequest, deps: BuildDeps = {}): Promise<BuildPageResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY_PAGES };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what the page should show." };
  if (deps.stub ?? devStubOn()) return checkBuiltSpec(stubPageSpec(req.prompt));
  const project = projectName(req.projectId);
  return askFirstMate(
    { monoId: req.monoId, prompt: req.prompt, ...(project ? { projectId: req.projectId } : {}) },
    newPageAsk(req.prompt, project),
    deps,
  );
}

/**
 * Rebuild a kept page from Ash's words (with its `pageId`). The answer is the page's new version: it waits on the page
 * until Ash uses it or throws it away; the page runs as it was until then.
 */
export async function rebuildPage(req: RebuildPageRequest, deps: BuildDeps = {}): Promise<BuildPageResult> {
  if (!isSeatedMono(req.monoId, deps.roster)) return { status: "turned-down", reason: SEATED_ONLY_PAGES };
  if (!req.prompt.trim()) return { status: "turned-down", reason: "Say what should change on the page." };
  if (deps.stub ?? devStubOn()) return checkBuiltSpec(req.current ? stubRebuildSpec(req.current, req.prompt) : stubPageSpec(req.prompt));
  const title = req.current?.title ?? "this page";
  const project = projectName(req.projectId);
  const result = await askFirstMate(
    { monoId: req.monoId, prompt: req.prompt, change: { pageId: req.pageId, title }, ...(project ? { projectId: req.projectId } : {}) },
    changePageAsk(req.prompt, title, req.current, project),
    deps,
  );
  return result.status === "ready" ? { ...result, replaces: req.pageId } : result;
}

/** Send the ask to the first mate's own chat, then wait (bounded) for its page_build there. */
async function askFirstMate(ask: Omit<PageAsk, "id" | "at">, text: string, deps: BuildDeps): Promise<BuildPageResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const name = (deps.roster ?? listMonos()).find((m) => m.id === ask.monoId)?.name || ask.monoId;
  const later = ask.change ? "the new version waits on this page" : "it shows up on Pages";
  const chat = deps.chat === undefined ? monoChatHost() : deps.chat;
  if (!chat) return { status: "error", reason: `Pages can't reach ${name}'s chat from this window. Try again, or ask ${name} in its chat.` };
  let session: { id: string } | undefined;
  try {
    session = await chat.ensure(ask.monoId);
  } catch {
    session = undefined;
  }
  if (!session?.id) return { status: "error", reason: `${name} has no chat that can take this yet. Try again in a moment.` };
  const before = chat.read(session.id);
  if (before?.pendingQuestion) return { status: "busy", reason: `${name} is waiting on your answer to a question in its chat. Answer it there, then Try again.` };
  if (before?.busy) return { status: "busy", reason: `${name} is in the middle of something else. Try again when it's done, or pick another first mate.` };

  // Open the ask before sending, so a fast page_build is never missed.
  const id = `ask-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let settled: { answer?: PageAskAnswer } | undefined;
  const answered = openPageAsk({ ...ask, id, at: now() }).then((answer) => {
    settled = { answer };
  });
  let sent = false;
  try {
    sent = await chat.submit(session.id, text);
  } catch {
    sent = false;
  }
  if (!sent) {
    closePageAsk(id);
    return { status: "error", reason: `${name}'s chat didn't take the ask just now. Try again.` };
  }

  const end = now() + BUILD_TOTAL_SECONDS * 1000;
  let sawBusy = false;
  for (;;) {
    if (settled) {
      const a = settled.answer;
      if (!a) return { status: "error", reason: `A newer ask went to ${name}, so this one stopped waiting.` };
      return { status: "ready", spec: a.spec, warnings: a.warnings, ...(a.previewId ? { previewId: a.previewId } : {}) };
    }
    const s = chat.read(session.id);
    if (!s) {
      closePageAsk(id);
      return { status: "error", reason: `${name}'s chat closed before a page came back. Try again.` };
    }
    if (s.busy) sawBusy = true;
    if (s.pendingQuestion) return { status: "no-page", reason: `${name} asked you something in its chat. Answer it there; when the page is built, ${later}. Or Try again.` };
    const exchange = latestExchange(s.blocks, false);
    const replied = !!exchange.reply && !!exchange.you?.includes(ask.prompt.trim());
    if (!s.busy && (sawBusy || replied)) {
      // Its turn is over. A page_build in it has already answered; give that answer its moment to land.
      await Promise.resolve();
      if (settled) continue;
      closePageAsk(id);
      const said = (exchange.reply ?? "").trim().replace(/\s+/g, " ");
      const quote = said ? ` It said: “${said.length > 280 ? `${said.slice(0, 279)}…` : said}”` : "";
      return { status: "no-page", reason: `${name} answered in its chat without a page.${quote} Try again, or open its chat.` };
    }
    if (now() + BUILD_RECHECK_MS > end) {
      return {
        status: "no-page",
        reason: `No page from ${name} after ${Math.round(BUILD_TOTAL_SECONDS / 60)} minutes. If it's still at it, ${later} when it's done. Try again, or open its chat to see where it is.`,
      };
    }
    await Promise.race([answered, sleep(BUILD_RECHECK_MS)]);
  }
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
