// Who owns delegated work: the chats Ash talks to (Ash, 20 Oct: "I don't talk to workers. I only talk to
// orchestrators"). A Mono's own chat (a Lead, the leadership team, any other Mono) and a chat in a hub project's coding
// team (hub/model/codingTeam.ts). Their workers' reports, questions, stuck cards, Stop for everything beneath and PR
// wakes come back to them; a worker's go to whoever started it. What only a Mono has (its soul, memory files, habits,
// its private Codex store) still asks isMonoSession.
import { isCodingTeamChat } from "../../hub/model/codingTeam";
import { isMonoSession } from "./mono";

export function isOrchestratorChat(sessionId: string): boolean {
  return isMonoSession(sessionId) || isCodingTeamChat(sessionId);
}
