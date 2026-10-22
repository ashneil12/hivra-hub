// Tells the delegation store which chats run a turn now (r30h): a failed worker turns red "Needs you" once its Lead's
// turn has ended after reading the failure (workerStuck.ts leadTurnOver). Session.busy is the signal: no timer.
import { useEffect } from "react";
import type { Session } from "../../sessions/model/session";
import { setBusyChats } from "../model/delegationStore";

export function busyChatIds(sessions: readonly Pick<Session, "id" | "busy">[]): string[] {
  return sessions.filter((session) => session.busy).map((session) => session.id);
}

export function useBusyChatsFeed(sessions: readonly Pick<Session, "id" | "busy">[]): void {
  const key = busyChatIds(sessions).sort().join("\n");
  // r51: and which chats this window holds, so a Lead chat it doesn't hold is "not known", never "not busy".
  const known = sessions.map((session) => session.id).sort().join("\n");
  useEffect(() => {
    setBusyChats(key ? key.split("\n") : [], known ? known.split("\n") : []);
  }, [key, known]);
}
