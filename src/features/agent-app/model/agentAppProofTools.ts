// PT-1: the `proof_tools` tool a first mate calls (src-tauri/src/mcp_server.rs sends `proof_tools.list` and
// `proof_tools.propose`; src-tauri/src/proof_tools/mcp.rs). `list` says which open-source proof tools fit the project and which
// it already has. `propose` puts ONE tool the project lacks to the person, as a Needs-you decision through the existing ask
// path (`tasks.ask`: first mates only, the project's decision key), at most once per project per tool. The app never installs
// a tool: when the person answers "Add it" the answer comes back to the first mate, which briefs a worker to run the install
// command this module hands back. "Not now" is remembered per project (offers.rs) and the tool is never proposed again.
import { invoke } from "@tauri-apps/api/core";
import { readProofToolList } from "../../proofTools/model/proofTools";
import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";

/** The FIELDS entries of the two actions (agentApp.ts). `project` names one of a first mate's projects. */
export const PROOF_TOOLS_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["proof_tools.list", ["project"]],
  ["proof_tools.propose", ["project", "toolId"]],
];

/** The app's side: detection and the once-per-project record (src-tauri/src/proof_tools). A test swaps it for a fake. */
export type ProofToolsBackend = {
  list(folder: string): Promise<unknown>;
  claim(folder: string, toolId: string): Promise<unknown>;
  release(folder: string, toolId: string, revision: number): Promise<unknown>;
};

const liveBackend: ProofToolsBackend = {
  list: (folder) => invoke("proof_tools_list", { folder }),
  claim: (folder, toolId) => invoke("proof_tools_propose_claim", { folder, toolId }),
  release: (folder, toolId, revision) => invoke("proof_tools_propose_release", { folder, toolId, revision }),
};

type Status = "open" | "proposed" | "declined";

/** What the app says about a proposal (offers.rs `ClaimView`). An answer this file can't read is an error, never a guess. */
type Claim = {
  claimed: boolean;
  status: Status;
  revision: number;
  key: string;
  question: string;
  options: string[];
  recommended: string;
  install: string;
  note: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readClaim(payload: unknown): Claim | null {
  const view = record(payload);
  if (!view) return null;
  const tool = record(view.tool);
  const { claimed, status, revision, key, question, options, recommended, note } = view;
  if (typeof claimed !== "boolean") return null;
  if (status !== "open" && status !== "proposed" && status !== "declined") return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return null;
  if (typeof key !== "string" || !key.trim() || key.length > 120) return null;
  if (typeof question !== "string" || !question.trim() || question.length > 400) return null;
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) return null;
  if (!options.every((option) => typeof option === "string" && option.trim() && option.length <= 200)) return null;
  if (typeof recommended !== "string" || !options.includes(recommended)) return null;
  if (typeof note !== "string") return null;
  if (!tool || typeof tool.install !== "string" || !tool.install.trim()) return null;
  return { claimed, status, revision, key, question, options: options as string[], recommended, install: tool.install, note };
}

/** Only a first mate's own chat (a Mono's, or a coding team's) may use it. A Mono's habit run is a Mono session, but not that chat. */
function firstMate(source: Session, host: AgentAppHost): void {
  const mono = host.isMono(source.id) && !host.isHabitRun?.(source.id) ? host.monoOf?.(source.id) : undefined;
  const team = mono ? undefined : host.codingTeamOf?.(source.id);
  if (mono || team) return;
  throw new Error(
    host.isHabitRun?.(source.id)
      ? "A habit run doesn't propose proof tools. The first mate does, from its own chat."
      : "Only a first mate's own chat (a Mono's chat or a coding-team chat) uses proof_tools. A worker reports to the chat that delegated it.",
  );
}

const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function toolIdOf(input: Record<string, unknown>): string {
  const id = input.toolId;
  if (typeof id !== "string" || !TOOL_ID.test(id.trim())) throw new Error("toolId must be the id of a tool that proof_tools list showed.");
  return id.trim();
}

/** What the person answered, when the ask came back already answered (a standing answer, or the key was answered before). */
function alreadyAnswered(asked: unknown): string | null {
  const result = record(asked);
  if (!result || result.state !== "answered") return null;
  return typeof result.answer === "string" && result.answer.trim() ? result.answer.trim() : null;
}

const NOT_NOW = "Not now";

/**
 * The `proof_tools.*` actions (agentApp.ts dispatches them here after checking their fields). `projectOf` is the project
 * choice every other action makes; `ask` is the existing ask-the-person action (`tasks.ask`), which also refuses anyone but
 * the chat the person talks to.
 */
export async function handleProofTools(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  projectOf: (source: Session, input: Record<string, unknown>) => string,
  ask: (input: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  if (action !== "proof_tools.list" && action !== "proof_tools.propose") throw new Error(`Unknown app action: ${action}`);
  firstMate(source, host);
  const backend = host.proofTools ?? liveBackend;
  const folder = projectOf(source, input);

  if (action === "proof_tools.list") {
    if (input.toolId !== undefined) throw new Error("proof_tools list takes no toolId.");
    const list = readProofToolList(await backend.list(folder));
    if (!list) throw new Error("This project's proof tools couldn't be read. Nothing was changed.");
    // PT-2: `revision` is what Settings bases a switch write on; a first mate has no use for it.
    const { revision: _revision, ...tools } = list;
    return {
      ...tools,
      project: folder,
      note: "These are the proof tools that fit this project. Use the ones it has. A tool marked off is switched off for this project: don't use it and don't propose it. To add one it lacks, propose it (action propose, once) when it would catch something its tests miss: the person decides, and the app installs nothing.",
    };
  }

  const toolId = toolIdOf(input);
  const claim = readClaim(await backend.claim(folder, toolId));
  if (!claim) throw new Error("The app's answer about that proof tool couldn't be read. Nothing was proposed.");
  // Once per project per tool: a tool already proposed, declined, installed or that doesn't fit asks nothing.
  if (!claim.claimed) return { proposed: false, toolId, status: claim.status, note: claim.note };

  let asked: unknown;
  try {
    asked = await ask({
      key: claim.key,
      question: claim.question,
      options: claim.options,
      recommended: claim.recommended,
    });
  } catch (error) {
    // The question wasn't filed (a timeout, the store unreachable): that is not a final "no". Undo the claim so the first
    // mate can propose again, and say why.
    await backend.release(folder, toolId, claim.revision).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
  const answer = alreadyAnswered(asked);
  const note =
    answer === null
      ? `Asked the person. If they answer ${claim.options[0]}, brief a worker to run: ${claim.install} (the app does not install anything itself). If they answer ${NOT_NOW}, don't propose it again.`
      : answer.toLowerCase() === NOT_NOW.toLowerCase()
        ? "The person already said Not now. Don't propose it again."
        : `The person already answered "${answer}". If that is yes, brief a worker to run: ${claim.install} (the app does not install anything itself).`;
  return {
    proposed: true,
    toolId,
    key: claim.key,
    question: claim.question,
    install: claim.install,
    ...(answer === null ? {} : { answer }),
    note,
  };
}
