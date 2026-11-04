// WP-23: how a council is convened from a chat, and how its verdict is handed on as an ordinary brief.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { formatLeadBrief, type LeadBrief } from "../../hub/model/leadershipDelegation";
import { appendMessage, createChat, saveCouncil } from "../../hub/model/hubChats";
import { currentHubSelection, setHubSelection } from "../../hub/model/hubNav";
import { listCustomModels, type CustomModel } from "../../sessions/model/customModels";
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

/**
 * One ask for every seat, through the same `model_quick_pick` a room already uses. No CLI is launched.
 * The verdict goes to a different connected provider when one is there. With no model connected, this is unset.
 */
export function councilAsk(
  models: readonly Pick<CustomModel, "id" | "provider" | "baseUrl" | "modelId">[],
  ask: (model: Pick<CustomModel, "id" | "provider" | "baseUrl" | "modelId">, prompt: string) => Promise<string>,
): CouncilModel | undefined {
  const connected = models.filter((model) => model.id && model.provider && model.modelId);
  if (!connected.length) return undefined;
  const usual = connected[0];
  const chair = connected.find((model) => model.provider !== usual.provider) ?? usual;
  return async ({ round, prompt, signal }) => {
    if (signal.aborted) throw new DOMException("The council was stopped.", "AbortError");
    const text = await ask(round === "verdict" ? chair : usual, prompt);
    if (signal.aborted) throw new DOMException("The council was stopped.", "AbortError");
    return { text: typeof text === "string" ? text : "" };
  };
}

/** Lend the room's connected model, once. Outside the app, or with nothing connected, a council can still be proposed. */
export function installCouncilModel(): void {
  if (councilModel) return;
  let inApp = false;
  try {
    inApp = isTauri();
  } catch {
    inApp = false;
  }
  if (!inApp) return;
  let models: CustomModel[] = [];
  try {
    models = listCustomModels();
  } catch {
    models = [];
  }
  const built = councilAsk(models, (model, prompt) =>
    invoke<string>("plugin:hub|model_quick_pick", {
      provider: model.provider,
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      customModelId: model.id,
      system: "You are one seat on a council. Answer only what the prompt asks.",
      prompt,
      timeoutMs: 120_000,
    }),
  );
  if (built) councilModel = built;
}

export type CouncilSeatOpener = (seat: { sessionId: string; label: string }) => void;
let seatOpener: CouncilSeatOpener | undefined;
export function setCouncilSeatOpener(open: CouncilSeatOpener | undefined): void {
  seatOpener = open;
}
export function openCouncilSeat(seat: { sessionId: string; label: string }): void {
  seatOpener?.(seat);
}

export type CouncilDelegator = (brief: LeadBrief, record: CouncilRecord) => void;
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
    delegator?.(brief, record);
  } catch {
    /* the brief is in the room either way */
  }
  return text;
}

/**
 * `/council` from a first mate chat. Opens a new room on the current project and selects it. With no project chosen,
 * nothing is opened and the line is left for the caller to keep.
 */
export function requestCouncil(question: string): boolean {
  const project = currentHubSelection().project;
  if (!project) return false;
  const asked = question.trim();
  const chat = createChat(project, asked ? `Council: ${asked.slice(0, 60)}` : "Council", []);
  if (!saveCouncil(chat.id, blankProposal(asked), 0)) return false;
  setHubSelection({ project, item: `chat:${chat.id}` });
  return true;
}
