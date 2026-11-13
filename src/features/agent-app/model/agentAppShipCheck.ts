// SC-3b: the `ship_check` tool a first mate calls (src-tauri/src/mcp_server.rs sends `ship_check.run`). It runs the ship
// check for the first mate's project (src-tauri/src/ship_check.rs): every check, the real-app check and a review over
// everything that landed since the last passed ship check. The answer is what a first mate may report: the outcome, the
// version, and what was and was not tested. A worker, a habit run and the checker never run it.
import { runShipCheck, shortSha, type ShipCheckBackend } from "../../hub/model/shipCheck";
import type { Session } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";

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
};

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
): Promise<ShipCheckAnswer> {
  if (action !== "ship_check.run") throw new Error(`Unknown app action: ${action}`);
  firstMate(source, host);
  const cwd = projectOf(source, input);
  const backend: Pick<ShipCheckBackend, "run"> | undefined = host.shipCheck;
  const record = await (backend ? runShipCheck(cwd, backend) : runShipCheck(cwd));
  return {
    outcome: record.outcome,
    head: record.head,
    version: shortSha(record.head),
    commitsCovered: record.commitsCovered,
    note: record.note,
    tested: record.tested,
    notTested: record.notTested,
    steps: record.steps.map(({ name, outcome, detail }) => ({ name, outcome, detail })),
  };
}
