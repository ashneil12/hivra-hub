// Tests only: the intent and definition of done a brief needs since Hivra WP-10 (firstmate/model/brief.ts). Tests written
// before WP-10 sent a spec alone; they get these unless they name their own.
import { handleAgentApp as handle } from "../../agent-app/model/agentApp";
import { isAppDelegate, markAppDelegate } from "../../agent-app/model/agentAppTasks";

export const TEST_INTENT = "Ash asked for this in his own words.";
export const TEST_GOAL = "The checks named in the brief pass.";

/** handleAgentApp, with a delegation's intent and goal filled in when the test leaves them out. */
export const handleWithBriefParts: typeof handle = (source, requestId, action, input, host) => {
  const filled = action === "tasks.delegate" ? { intent: TEST_INTENT, goal: TEST_GOAL, ...input } : input;
  // The spread drops the app's mark. Put it back, the way App marks after withLegacyBriefParts.
  return handle(source, requestId, action, isAppDelegate(input) ? markAppDelegate(filled) : filled, host);
};
