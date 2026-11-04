// WP-23: how a council is convened from a chat, and how its verdict is handed on as an ordinary brief.
import { formatLeadBrief, type LeadBrief } from "../../hub/model/leadershipDelegation";
import { appendMessage, createChat, saveCouncil } from "../../hub/model/hubChats";
import { currentHubSelection, setHubSelection } from "../../hub/model/hubNav";
import { defaultModelId, resolveModel } from "../../sessions/model/models";
import { HARNESS_TITLE, HARNESSES, type HarnessId } from "../../sessions/model/session";
import { isHarnessAvailable } from "../../../integrations/harness/core/availabilityState";
import { blankProposal, type CouncilRecord } from "./record";
import type { CouncilEngine } from "./protocol";
import type { CouncilModel } from "./run";

/** The model family a CLI stands for. Two CLIs on one family are two seats of that family. */
const FAMILY: Record<HarnessId, string> = {
  claude: "Anthropic",
  codex: "OpenAI",
  cursor: "Cursor",
  grok: "xAI",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  fx: "fx",
  hermes: "Hermes",
  antigravity: "Google",
  devin: "Devin",
};

export function enginesFromHarness(ids: readonly HarnessId[]): CouncilEngine[] {
  return ids.map((id) => ({ cli: id, family: FAMILY[id], label: HARNESS_TITLE[id] }));
}

/**
 * Engines the app can see. The probe only knows a CLI is installed, not that anyone is signed in to it (harness.rs has
 * no login bit). The council's own words still say "signed in", which is as close as this app can tell.
 */
/** The model a new session on that CLI would use. An engine that already names one, or an unknown CLI, is left as it is. */
export function withSeatModels(engines: readonly CouncilEngine[]): CouncilEngine[] {
  return engines.map((engine) => {
    if (engine.model?.trim()) return engine;
    if (!(HARNESSES as readonly string[]).includes(engine.cli)) return engine;
    const id = engine.cli as HarnessId;
    try {
      const model = resolveModel(id, defaultModelId(id));
      return model.name ? { ...engine, model: model.name } : engine;
    } catch {
      return engine;
    }
  });
}

export function availableCouncilEngines(): CouncilEngine[] {
  return withSeatModels(enginesOverride ?? enginesFromHarness(HARNESSES.filter((id) => isHarnessAvailable(id))));
}

let enginesOverride: CouncilEngine[] | undefined;
/** Tests and the browser proof name the engines. The app uses {@link availableCouncilEngines}. */
export function setCouncilEnginesForTests(engines: CouncilEngine[] | undefined): void {
  enginesOverride = engines;
}

let councilModel: CouncilModel | undefined;
/** The app lends one model for every seat. Unset, a council can be proposed but not run. */
export function setCouncilModel(model: CouncilModel | undefined): void {
  councilModel = model;
}
export function councilModelInUse(): CouncilModel | undefined {
  return councilModel;
}

/** One seat the running council can ask. `id` is the seat, `sessionId` is its own CLI session. */
export type CouncilSeatCall = {
  id: string;
  cli: string;
  model?: string;
  sessionId: string;
  label: string;
};

/**
 * How the app starts a seat and takes its answer. `ensure` returns the session id (making it when it is not open).
 * `ask` is the same submit a room already uses. No CLI is launched from here.
 */
export type CouncilSeatHost = {
  ensure(seat: CouncilSeatCall): string;
  ask(sessionId: string, prompt: string, signal: AbortSignal): Promise<{ text: string; tokens?: number }>;
};

let seatHost: CouncilSeatHost | undefined;
export function setCouncilSeatHost(host: CouncilSeatHost | undefined): void {
  seatHost = host;
}

const notedSeats = new Map<string, CouncilSeatCall>();
/** The seats of the council on screen, so an ask that names only a seat id still reaches that seat's CLI. */
export function noteCouncilSeats(seats: readonly CouncilSeatCall[]): void {
  notedSeats.clear();
  for (const seat of seats) notedSeats.set(seat.id, seat);
}

function stopped(): DOMException {
  return new DOMException("The council was stopped.", "AbortError");
}

function seatFor(input: { seatId: string; cli?: string; model?: string; sessionId?: string }): CouncilSeatCall | undefined {
  const noted = notedSeats.get(input.seatId);
  if (input.cli && input.sessionId) {
    return {
      id: input.seatId,
      cli: input.cli,
      ...(input.model ? { model: input.model } : noted?.model ? { model: noted.model } : {}),
      sessionId: input.sessionId,
      label: noted?.label ?? input.seatId,
    };
  }
  return noted;
}

/**
 * One ask per seat, through that seat's own CLI and session. The verdict is whichever seat the caller names (the chairman).
 * With no seats, this is unset.
 */
export function councilAsk(
  seats: readonly { id: string; cli: string; model?: string; sessionId: string }[],
  ask: (seat: { id: string; cli: string; model?: string; sessionId: string }, prompt: string) => Promise<string>,
): CouncilModel | undefined {
  if (!seats.length) return undefined;
  const byId = new Map(seats.map((seat) => [seat.id, seat]));
  return async ({ seatId, prompt, signal, cli, model, sessionId }) => {
    if (signal.aborted) throw stopped();
    const listed = byId.get(seatId);
    const seat = cli && sessionId ? { id: seatId, cli, model, sessionId } : listed;
    if (!seat) throw new Error("That seat is not on this council.");
    const text = await ask(seat, prompt);
    if (signal.aborted) throw stopped();
    return { text: typeof text === "string" ? text : "" };
  };
}

/**
 * Lend the app's seat host, once. Outside the app (no host), or when a model is already set, a council can still be proposed.
 * Each ask goes to that seat's own session. The verdict round is just the chairman's seat.
 */
export function installCouncilModel(): void {
  if (councilModel || !seatHost) return;
  const host = seatHost;
  councilModel = async (input) => {
    if (input.signal.aborted) throw stopped();
    const seat = seatFor(input);
    if (!seat) throw new Error("That seat is not on this council.");
    const sessionId = host.ensure(seat);
    const out = await host.ask(sessionId, input.prompt, input.signal);
    if (input.signal.aborted) throw stopped();
    return { text: typeof out?.text === "string" ? out.text : "", ...(typeof out?.tokens === "number" ? { tokens: out.tokens } : {}) };
  };
}

export type CouncilSeatOpener = (seat: { sessionId: string; label: string; id?: string; cli?: string; model?: string }) => void;
let seatOpener: CouncilSeatOpener | undefined;
export function setCouncilSeatOpener(open: CouncilSeatOpener | undefined): void {
  seatOpener = open;
}
export function openCouncilSeat(seat: { sessionId: string; label: string; id?: string; cli?: string; model?: string }): void {
  seatOpener?.(seat);
}

export type CouncilDelegator = (brief: LeadBrief, record: CouncilRecord, chatId: string) => void;
let delegator: CouncilDelegator | undefined;
export function setCouncilDelegator(next: CouncilDelegator | undefined): void {
  delegator = next;
}

/** The verdict as a normal brief: the next step is the outcome, the kill criteria say what done is not. */
export function councilBrief(record: CouncilRecord): LeadBrief | undefined {
  if (!record.verdict?.nextStep) return undefined;
  return {
    outcome: record.verdict.nextStep,
    done: record.verdict.killCriteria,
    alreadyFinished: record.verdict.unresolved,
    ...(record.question ? { ashWords: record.question } : {}),
  };
}

/** Post the verdict into the room that convened the council, and tell a waiting first mate when one is listening. */
export function postCouncilBrief(chatId: string, record: CouncilRecord): string | undefined {
  const brief = councilBrief(record);
  if (!brief) return undefined;
  const text = formatLeadBrief("the council", brief);
  appendMessage(chatId, undefined, { from: "app", kind: "system", text });
  try {
    delegator?.(brief, record, chatId);
  } catch {
    /* the brief is in the room either way */
  }
  return text;
}

/**
 * `/council` from a chat. Opens a new room on the current project, with the members the caller names, and selects it.
 * With no project chosen, nothing is opened and the line is left for the caller to keep.
 */
export function requestCouncil(question: string, memberIds: readonly string[] = []): boolean {
  const project = currentHubSelection().project;
  if (!project) return false;
  const asked = question.trim();
  const members: string[] = [];
  for (const raw of memberIds) {
    const id = raw.trim();
    if (id && !members.includes(id)) members.push(id);
  }
  const chat = createChat(project, asked ? `Council: ${asked.slice(0, 60)}` : "Council", members);
  if (!saveCouncil(chat.id, blankProposal(asked), 0)) return false;
  setHubSelection({ project, item: `chat:${chat.id}` });
  return true;
}
