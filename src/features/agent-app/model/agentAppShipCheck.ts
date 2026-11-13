// SC-3b: the `ship_check` tool a first mate calls (src-tauri/src/mcp_server.rs sends `ship_check.run`). It runs the ship
// check for the first mate's project (src-tauri/src/ship_check.rs): every check, the real-app check and a review over
// everything that landed since the last passed ship check. The answer is what a first mate may report: the outcome, the
// version, and what was and was not tested. A worker, a habit run and the checker never run it.
import { runShipCheck, shortSha, type ShipCheckBackend, type ShipFinding } from "../../hub/model/shipCheck";
import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";
import { proofToolsBackendOf, proposeProofTool } from "./agentAppProofTools"; // PT-4
import { fileTestDebtAsks, readTestDebtFollow, startTestFixer, tauriTestDebt, type AskOutcome } from "./agentAppTestDebt"; // PT-5

/** The FIELDS entry of the ship check action (agentApp.ts). `project` names one of a first mate's projects. */
export const SHIP_CHECK_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [["ship_check.run", ["project"]]];

export type ShipCheckAnswer = {
  outcome: "passed" | "failed" | "couldNotRun";
  head: string;
  version: string;
  commitsCovered: number;
  note: string | null;
  tested: string[];
  notTested: string[];
  steps: { name: string; outcome: string; detail: string }[];
  /**
   * PT-4: the proof tools this ship check put to the person because the project could use them and lacks them (at most three,
   * once per project per tool). Each is what `proof_tools propose` answers. Absent when none was put forward.
   */
  proposals?: Record<string, unknown>[];
  /** PT-4: what to tell the person about them. Present with `proposals`. */
  proposalsNote?: string;
  /**
   * PT-5: named findings that do not block the pass: a real bug a test caught (it is also one Needs-you item), a flaky test that is
   * quarantined, a quarantine that ran out. Say each in one line.
   */
  findings?: ShipFinding[];
  /**
   * PT-5: what the list of failing tests led to this time: the one test fixer task that was started (feature work keeps going), and
   * the Needs-you items put to the person. `note` is what to tell them, in plain words.
   */
  testDebt?: {
    fixer?: { started: boolean; title?: string; note: string };
    asked?: AskOutcome[];
    note: string;
  };
};

/** The note that goes with the proposals: the person decides, and the app installs nothing. */
export const PROPOSALS_NOTE =
  "The ship check found proof tools this project could use and doesn't have. Each one that says proposed is now a question for the person under Needs you: tell them in one line that it is waiting. The app installs nothing: only if they answer Add it, brief a worker to run the install command it gives.";

/** Only a first mate's own chat (a Mono's, or a coding team's) may run it. A Mono's habit run is a Mono session, but not that chat. */
function firstMate(source: Session, host: AgentAppHost): void {
  const mono = host.isMono(source.id) && !host.isHabitRun?.(source.id) ? host.monoOf?.(source.id) : undefined;
  const team = mono ? undefined : host.codingTeamOf?.(source.id);
  if (mono || team) return;
  throw new Error(
    host.isHabitRun?.(source.id)
      ? "A habit run doesn't run the ship check. The first mate does, from its own chat."
      : "Only a first mate's own chat (a Mono's chat or a coding-team chat) runs the ship check. A worker reports to the chat that delegated it.",
  );
}

/**
 * The `ship_check.run` action (agentApp.ts dispatches it here after checking its fields). `projectOf` is the same
 * project choice every other action makes (the chat's own, or the one a Mono names). The run can take minutes; a second
 * ask for the same project joins the one that is out (hub/model/shipCheck.ts).
 */
export async function handleShipCheck(
  source: Session,
  action: string,
  input: Record<string, unknown>,
  host: AgentAppHost,
  projectOf: (source: Session, input: Record<string, unknown>) => string,
  /** PT-4: the existing ask-the-person action (`tasks.ask`), which a proposal is filed through. Absent: none is filed. */
  ask?: (input: Record<string, unknown>) => Promise<unknown>,
  /** PT-5: the existing delegation path (`tasks.delegate`) bound to this chat, which the test fixer task is started through. Absent: none is started. */
  delegate?: (token: string, input: Record<string, unknown>) => Promise<unknown>,
): Promise<ShipCheckAnswer> {
  if (action !== "ship_check.run") throw new Error(`Unknown app action: ${action}`);
  firstMate(source, host);
  const cwd = projectOf(source, input);
  const backend: Pick<ShipCheckBackend, "run"> | undefined = host.shipCheck;
  const record = await (backend ? runShipCheck(cwd, backend) : runShipCheck(cwd));
  // PT-4: each tool the ship check put forward goes through PT-1's claim and ask, one after the other: the claim is what makes a
  // proposal once per project per tool, so a second window or a retry asks nothing twice. One that can't be filed (a timeout, the
  // decision store unreachable) is released by `proposeProofTool` so the next ship check may put it forward again, and says why.
  const proposals: Record<string, unknown>[] = [];
  if (ask) {
    const proofTools = proofToolsBackendOf(host);
    for (const proposal of record.proposals ?? []) {
      try {
        proposals.push(await proposeProofTool(cwd, proposal.toolId, proofTools, ask));
      } catch (error) {
        proposals.push({
          proposed: false,
          toolId: proposal.toolId,
          note: `Couldn't ask about ${proposal.name} this time (${error instanceof Error ? error.message : String(error)}). The next ship check will put it forward again.`,
        });
      }
    }
  }
  // PT-5: the list of failing tests. The run only says what is due: the app claims the one fixer slot and each Needs-you item when this
  // asks for it (so a ship check run from a card claims nothing), and a start or a question that can't go through is given back and said,
  // never a final failure.
  const follow = readTestDebtFollow(record.testDebt);
  const debtBackend = host.testDebt ?? tauriTestDebt;
  const debt: NonNullable<ShipCheckAnswer["testDebt"]> = { note: "" };
  const notes: string[] = [];
  if (follow.fixerDue && delegate) {
    const outcome = await startTestFixer(cwd, delegate, debtBackend, typeof input.project === "string" ? input.project : undefined);
    debt.fixer = outcome.started ? { started: true, title: outcome.title, note: outcome.note } : { started: false, note: outcome.note };
    notes.push(outcome.note);
  }
  if (ask && (follow.bugs.length || follow.proposals.length)) {
    debt.asked = await fileTestDebtAsks(cwd, follow, ask, debtBackend);
    for (const one of debt.asked) notes.push(one.note);
  }
  if (notes.length) debt.note = notes.join(" ");
  return {
    outcome: record.outcome,
    head: record.head,
    version: shortSha(record.head),
    commitsCovered: record.commitsCovered,
    note: record.note,
    tested: record.tested,
    notTested: record.notTested,
    steps: record.steps.map(({ name, outcome, detail }) => ({ name, outcome, detail })),
    ...(proposals.length ? { proposals, proposalsNote: PROPOSALS_NOTE } : {}),
    ...(record.findings?.length ? { findings: record.findings } : {}),
    ...(debt.note ? { testDebt: debt } : {}),
  };
}
