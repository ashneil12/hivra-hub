// WP-43. Which first mate or Mono a chat's browser profile belongs to. Workers of that
// agent share it. Any other chat gets its own, so it never picks up someone else's logins
// or the person's browser.

import { codingTeamChatProject, codingTeamName, startedByCodingTeamChat } from "../../hub/model/codingTeam";
import { registryProjects } from "../../hub/model/hubData";
import { defaultMonoName, listMonos, monoForSession, type Mono } from "../../monos/model/mono";

export type BrowserAgent = { id: string; name: string };

const KINDS = ["mono", "team", "chat"] as const;

/** An id the profile folder can be named: no slashes, no "..", no leading dot. */
export function agentKey(kind: (typeof KINDS)[number], raw: string): string {
  let body = "";
  for (const ch of raw) {
    const point = ch.codePointAt(0) ?? 0;
    // `_` is the escape mark, so it is escaped too. Otherwise "caf_e9" and "café" share a profile.
    body += point === 0x5f || !/^[A-Za-z0-9-]$/.test(ch) ? `_${point.toString(16)}` : ch;
  }
  if (!body) body = "unknown";
  const mark = mix(`${kind}\0${raw}`);
  let id = `${kind}-${body}`;
  if (id.length > 120) {
    const room = 120 - mark.length - 1;
    id = `${id.slice(0, room)}_${mark}`;
  }
  return usable(id) ? id : "chat-unknown";
}

/** Two hashes of the whole id, so a cut at 120 characters can't collide. */
function mix(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}`;
}

function usable(id: string): boolean {
  return (
    id.length >= 1 &&
    id.length <= 120 &&
    !id.startsWith(".") &&
    !id.includes("..") &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}

function projects(): { id: string; name: string; shortName: string }[] {
  try {
    return registryProjects();
  } catch {
    return [];
  }
}

function monoOwning(sessionId: string, depth = 0): Mono | undefined {
  if (!sessionId || depth > 8) return undefined;
  const direct = monoForSession(sessionId);
  if (direct) return direct;
  if (!sessionId.startsWith("app-")) return undefined;
  let best: Mono | undefined;
  let bestLen = -1;
  for (const mono of listMonos()) {
    const ids = [mono.sessionId, ...Object.values(mono.roomSessions ?? {})].filter(
      (id): id is string => !!id,
    );
    for (const id of ids) {
      if (sessionId.startsWith(`app-${id}-`) && id.length > bestLen) {
        best = mono;
        bestLen = id.length;
      }
    }
  }
  if (best) return best;
  return monoOwning(sessionId.slice(4), depth + 1);
}

function monoName(mono: Mono): string {
  const named = (mono.name ?? "").trim();
  return named || defaultMonoName(mono.mascot || "");
}

/** The agent this chat browses as. Never throws. */
export function browserAgentFor(sessionId: string | undefined): BrowserAgent {
  const id = (sessionId ?? "").trim();
  try {
    const teamChat = codingTeamChatProject(id) ? id : startedByCodingTeamChat(id);
    if (teamChat) {
      const projectId = codingTeamChatProject(teamChat) || teamChat;
      const project = projects().find((item) => item.id === projectId);
      return { id: agentKey("team", projectId), name: codingTeamName(project) };
    }
    const mono = monoOwning(id);
    if (mono) return { id: agentKey("mono", mono.id), name: monoName(mono) };
    return { id: agentKey("chat", id), name: "This chat" };
  } catch {
    return { id: agentKey("chat", id), name: "This chat" };
  }
}
