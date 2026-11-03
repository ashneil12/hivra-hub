// Tests only: the intent and definition of done a brief needs since Hivra WP-10 (firstmate/model/brief.ts). Tests written
// before WP-10 sent a spec alone; they get these unless they name their own.
import { handleAgentApp as handle } from "../../agent-app/model/agentApp";

export const TEST_INTENT = "Ash asked for this in his own words.";
export const TEST_GOAL = "The checks named in the brief pass.";

/** handleAgentApp, with a delegation's intent and goal filled in when the test leaves them out. */
export const handleWithBriefParts: typeof handle = (source, requestId, action, input, host) =>
  handle(
    source,
    requestId,
    action,
    action === "tasks.delegate" ? { intent: TEST_INTENT, goal: TEST_GOAL, ...input } : input,
    host,
  );
