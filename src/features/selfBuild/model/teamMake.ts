import { useSyncExternalStore } from "react";
import { recordMadeTeam } from "../../hub/model/botChanges";
import { createTeam, listTeams } from "../../hub/model/hubTeams";
import { hubData } from "../../hub/model/hubData";
import { listMonos, monoLook } from "../../monos/model/mono";
import { projectKey } from "../../../shared/lib/paths";
import { forUser } from "../../hub/model/userName";
import { ASK_ASH_FIRST } from "./ashSaid";
import type { DraftPlace } from "./monoMake";

/**
 * A Mono proposes a team the way it proposes a Mono (A6): it drafts it with Ash (name, what it's for, its projects and
 * which named Monos belong), the card sits in the chat, and the team is made on his yes (`makeDraftedTeam`). There is
 * still one way to make staff: Ash answers. An agent can never make or restructure a team silently, and Undo in Bot
 * changes takes the team and its room away again (its Monos stay).
 */
export type TeamDraft = {
  id: string;
  at: number;
  by: { monoId: string; name: string };
  name: string;
  /** What the team is for, in Ash's own plain words. */
  brief: string;
  /** Hub project ids; the room lives in the first. */
  projects: string[];
  /** The named Monos that belong, as they were when drafted. */
  members: { id: string; name: string }[];
  /** The chat it was drafted in, where its card sits as a message. */
  where?: DraftPlace;
  /** Ash waved it off on the card: it isn't shown again. */
  dismissed?: boolean;
  dismissedAt?: number;
  /** Set once made: the same draft never makes a second team. */
  madeId?: string;
};

const KEY = "monocode:team-drafts";
function load(): TeamDraft[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as TeamDraft[];
    return Array.isArray(list)
      ? list.filter((d) => d && typeof d.id === "string")
      : [];
  } catch {
    return [];
  }
}
let version = 0;
const subs = new Set<() => void>();
function save(list: TeamDraft[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-20)));
  } catch {
    /* best effort */
  }
  version++;
  subs.forEach((f) => f());
}

/** The waiting team drafts whose card belongs in this chat. */
export function teamDraftsIn(
  drafts: readonly TeamDraft[],
  place: { room: string; conv?: string } | { session: string; monoId?: string },
): TeamDraft[] {
  return drafts.filter((d) => {
    const w = d.where;
    if ("room" in place) return !!w && "room" in w && w.room === place.room && (!w.conv || !place.conv || w.conv === place.conv);
    if (w) return "session" in w && w.session === place.session;
    return !!place.monoId && d.by.monoId === place.monoId;
  });
}
export function waitingTeamDrafts(): TeamDraft[] {
  return load().filter((d) => !d.madeId && !d.dismissed);
}
export function useWaitingTeamDrafts(): TeamDraft[] {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return waitingTeamDrafts();
}
/** Not this one: the card goes; nothing was made. */
export function dismissTeamDraft(id: string, now = Date.now()): void {
  save(load().map((d) => (d.id === id ? { ...d, dismissed: true, dismissedAt: now } : d)));
}

function text(value: unknown, what: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${what} must be text under ${max} characters`);
  return value.trim();
}
function strings(value: unknown, what: string, max = 20): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((v) => typeof v !== "string" || !v.trim() || v.length > 300)
  )
    throw new Error(`${what} must be a list of at most ${max} short strings`);
  return value.map((v: string) => v.trim());
}

/** The hub's projects with a folder, which is what a team can work on and where its room lives. */
function hubProjects(): { id: string; name: string; folder: string }[] {
  return hubData()
    .listProjects()
    .flatMap((p) => (p.folder ? [{ id: p.id, name: p.name, folder: p.folder }] : []));
}
/** Project names an agent gave (a hub id, name or folder), as hub ids. */
function resolveTeamProjects(wanted: readonly string[]): string[] {
  const hub = hubProjects();
  const ids = wanted.map((want) => {
    const lower = want.toLowerCase();
    const found = hub.find(
      (p) =>
        p.id.toLowerCase() === lower ||
        p.name.toLowerCase() === lower ||
        projectKey(p.folder) === projectKey(want),
    );
    if (!found) throw new Error(`Unknown project ${want}: name one of the app's projects.`);
    return found.id;
  });
  return [...new Set(ids)];
}
/** Mono names an agent gave (an id or a name), as the Monos that exist. */
function resolveMembers(wanted: readonly string[]): { id: string; name: string }[] {
  const monos = listMonos().map((m) => ({ id: m.id, name: monoLook(m).name }));
  const out = wanted.map((want) => {
    const lower = want.toLowerCase();
    const found = monos.find((m) => m.id.toLowerCase() === lower || m.name.toLowerCase() === lower);
    if (!found) throw new Error(`No Mono called ${want}: name an existing Mono, or leave members out and add them after.`);
    return found;
  });
  return [...new Map(out.map((m) => [m.id, m])).values()];
}

/**
 * Draft one team: checked now, nothing made. Returns what Ash is shown on the card.
 */
export function draftTeam(
  input: Record<string, unknown>,
  caller: { monoId: string; name: string },
  now = Date.now(),
  /** The chat it is drafted in: its card sits there, in the messages. */
  where?: DraftPlace,
): {
  draftId: string;
  plan: { name: string; brief: string; projects: string[]; members: string[] };
  note: string;
} {
  const name = text(input.name, "name", 40, true)!;
  if (listTeams().some((t) => t.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`There is already a ${name} team.`);
  const brief = text(input.brief, "brief", 2000, true)!;
  const projects = resolveTeamProjects(strings(input.projects, "projects", 10));
  if (!projects.length) throw new Error("Name at least one project for the team (its room lives in the first).");
  const members = resolveMembers(strings(input.members, "members", 20));
  const drafts = load().filter((d) => d.madeId || d.name.toLowerCase() !== name.toLowerCase());
  const draft: TeamDraft = {
    id: `team-draft-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: now,
    by: { monoId: caller.monoId, name: caller.name },
    name,
    brief,
    projects,
    members,
    ...(where ? { where } : {}),
  };
  save([...drafts, draft]);
  const hub = hubProjects();
  return {
    draftId: draft.id,
    plan: {
      name,
      brief,
      projects: projects.map((id) => hub.find((p) => p.id === id)?.name ?? id),
      members: members.map((m) => m.name),
    },
    note: forUser("Nothing is made yet. Ash sees the team's card (its name, what it's for, its projects and its Monos) in this chat, under your message. Tell him in a line or two that it's ready for his yes, and end your turn. The card has no yes button: its only button is \"Not this one\", and it tells him to say yes in the chat. So never tell him to click, tap or press it; ask for his yes here in the chat. After his yes, call team_create with only draftId. The card is there only until he answers it, so never point him to it after that."),
  };
}

export type MakeTeamHost = {
  /** Ash said something to the caller since this time (ashSaid.ts). */
  ashSpokeSince(since: number): boolean;
};

/** Make the drafted team, once Ash has answered: the team, its room and its Monos' seats. */
export async function makeDraftedTeam(
  draftId: unknown,
  caller: { monoId: string },
  host: MakeTeamHost,
): Promise<{
  made: string;
  teamId: string;
  alreadyMade?: boolean;
  members?: string[];
  room?: string;
  note?: string;
}> {
  if (typeof draftId !== "string" || !draftId)
    throw new Error("draftId must be the id team_create gave you");
  const drafts = load();
  const draft = drafts.find((d) => d.id === draftId && d.by.monoId === caller.monoId);
  if (!draft)
    throw new Error("No team draft with that id from you. Draft it again with name, brief and projects.");
  if (draft.dismissed && !draft.madeId)
    throw new Error(forUser`Ash turned this card down ("Not this one"), so nothing was made. Draft a new team only if he asks again.`);
  if (draft.madeId) {
    const made = listTeams().find((t) => t.id === draft.madeId);
    return {
      made: draft.name,
      teamId: draft.madeId,
      alreadyMade: true,
      ...(made ? {} : { note: "It was made, then undone in Bot changes." }),
    };
  }
  if (!host.ashSpokeSince(draft.at)) throw new Error(forUser(ASK_ASH_FIRST));
  const team = createTeam({
    name: draft.name,
    brief: draft.brief,
    projects: draft.projects,
    memberIds: draft.members.map((m) => m.id),
  });
  save(load().map((d) => (d.id === draft.id ? { ...d, madeId: team.id } : d)));
  recordMadeTeam(team, draft.by.name);
  const members = team.memberIds.map((id) => draft.members.find((m) => m.id === id)?.name ?? id);
  return {
    made: team.name,
    teamId: team.id,
    ...(members.length ? { members } : {}),
    room: `${team.name} team`,
    note: forUser`The ${team.name} team is there now, with its room${members.length ? ` and ${members.join(", ")} in it` : ""}, and Undo in Bot changes. Tell Ash in one line.`,
  };
}
