// Teams of named Monos (Ash 19 Oct: "creating a marketing team and creating little mono agents ... named agents that
// I can work with for marketing"). A team is a name, a short brief, its projects, its Monos and a team room. Workers
// stay subagents inside a Mono's session; only these named Monos are listed.
//
// Ash makes a team and its Monos himself on Settings > Teams (making it there is his okay). An agent proposes one in
// chat instead (mono_create / team_create, draft first) and nothing is made until Ash answers: the locked rule "a new
// named Mono or team needs Ash's okay". Undo in Bot changes takes a made team and its room away again (its Monos stay).
//
// The team room is a normal hub group chat (hubChats.createChat) in the team's first project, so it reuses the
// group-room code: members, conversations, the picked answerer and its replies.
import { defaultClaudeModelId } from "../../sessions/model/defaultClaudeModel";
import { useSyncExternalStore } from "react";
import { addMember, createChat, deleteChat } from "./hubChats";
import { catalogEntry, setMonoConnectors } from "./hubConnectors";
import { createMono, discardNewMono, findMono, listMonos, monoLook, saveMonoName, updateMono, type Mono } from "../../monos/model/mono";
import { loadMonoFiles, saveMonoFile } from "../../monos/model/monoFiles";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { projectKey } from "../../../shared/lib/paths";
import { hubData } from "./hubData";
import { forUser } from "./userName";
import { appTeamsStore, type TeamsDoc, type TeamsStore } from "./hubTeamsStore";

export const OPEN_TEAMS_EVENT = "monocode:open-teams";
/** Leave Settings for a hub view (App.tsx listens), e.g. a team's room. */
export const OPEN_HUB_EVENT = "monocode:open-hub";

/** What a named Mono is made from. `projects` are project folders (a Mono's own projects). */
export type MonoSpec = {
  name: string;
  /** One or two plain lines: what this Mono is for. Its SOUL is written from it unless `soul` is given. */
  brief: string;
  engine: HarnessId;
  projects: string[];
  /** Catalog ids this Mono may use (and only where its projects allow them). */
  connectors: string[];
  /** A full SOUL.md an agent drafted; Ash reads it before approving. */
  soul?: string;
};

export type Team = {
  id: string;
  name: string;
  brief: string;
  /** Hub project ids. The room lives in the first. */
  projects: string[];
  memberIds: string[];
  roomChatId?: string;
  roomProjectId?: string;
  createdAt: string;
};

export type MonoProposal = {
  id: string;
  /** An existing team, or the name of a team to make on approval. */
  teamId?: string;
  teamName?: string;
  spec: MonoSpec;
  proposedBy: { monoId?: string; name: string };
  at: string;
  status: "pending" | "approved" | "declined";
  /** The Mono made on approval. */
  monoId?: string;
};

type Stored = TeamsDoc;

const EVENT = "monocode:hub-teams-changed";
let version = 0;

// G7: kept in the app's database (the local hub document `hub-teams`, hubTeamsStore.ts), not this window's storage.
// The old key's teams come across once when the store is first read.
let store: TeamsStore | undefined;
function teamsStore(): TeamsStore {
  if (!store) {
    store = appTeamsStore();
    watch(store);
  }
  return store;
}
function watch(next: TeamsStore): void {
  next.subscribe(() => {
    version++;
    window.dispatchEvent(new CustomEvent(EVENT));
  });
  void next.load().catch(() => undefined);
}
/** What this window shows: the saved teams with its own changes on their way. */
function current(): Stored {
  return teamsStore().view();
}

/** One change, shown at once and saved on top of the latest record. A save that fails takes it back and says so. */
function save(change: (doc: Stored) => Stored): Promise<void> {
  return teamsStore().change(change).catch(() => undefined);
}

/** Adds a team once: made again on top of another window's change, it is not added twice. */
const withTeam = (team: Team) => (doc: Stored): Stored => (doc.teams.some((t) => t.id === team.id) ? doc : { ...doc, teams: [...doc.teams, team] });

/** Every team change asked so far has been saved (or given up). */
export function teamsSettled(): Promise<void> {
  const s = teamsStore();
  return s.load().then(() => s.settled(), () => s.settled());
}

/** Tests: read and write teams through this store. */
export function setTeamsStoreForTest(next: TeamsStore): void {
  store = next;
  watch(next);
}

/** Tests start clean: a fresh store (in memory outside the app), which copies the old key across once. */
export function resetTeamsForTests(): void {
  store = undefined;
}

export function useHubTeamsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      teamsStore();
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
}

export function listTeams(): Team[] {
  return current().teams;
}
export function getTeam(id: string): Team | undefined {
  return current().teams.find((t) => t.id === id);
}
export function teamOf(monoId: string): Team | undefined {
  return current().teams.find((t) => t.memberIds.includes(monoId));
}
export function pendingMonoProposals(): MonoProposal[] {
  return current().proposals.filter((p) => p.status === "pending");
}
/** The engine a Mono's conversation starts on (`Mono.engine`, read by monoWorkspace.ts); absent is the app default. */
export function monoEngine(monoId: string): HarnessId | undefined {
  const engine = findMono(monoId)?.engine;
  return engine && (HARNESSES as string[]).includes(engine) ? (engine as HarnessId) : undefined;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "team";
}

function cleanName(name: unknown, what: string, max = 40): string {
  if (typeof name !== "string" || !name.trim()) throw new Error(`${what} needs a name.`);
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length > max) throw new Error(`${what}'s name is over ${max} characters.`);
  return trimmed;
}

/**
 * Make a team. Ash does this himself, or it is a draft he said yes to (teamMake.ts); its room is a group chat in its
 * first project. `memberIds` are the named Monos that belong from the start, and sit in the room too.
 */
export function createTeam(input: { name: string; brief: string; projects: string[]; memberIds?: string[] }): Team {
  const name = cleanName(input.name, "A team");
  if (current().teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a ${name} team.`);
  if (!input.projects.length) throw new Error("Pick at least one project for the team.");
  const memberIds = [...new Set(input.memberIds ?? [])].filter((id) => listMonos().some((m) => m.id === id));
  const id = `team-${slug(name)}-${crypto.randomUUID().slice(0, 6)}`;
  const roomProjectId = input.projects[0];
  const room = createChat(roomProjectId, `${name} team`, memberIds);
  const team: Team = {
    id,
    name,
    brief: input.brief.trim().slice(0, 2000),
    projects: [...new Set(input.projects)],
    memberIds,
    roomChatId: room.id,
    roomProjectId,
    createdAt: new Date().toISOString(),
  };
  void save(withTeam(team));
  return team;
}

/**
 * Undo a made team: the record goes and its room with it. Its Monos stay (they are Ash's, in the sidebar), so undo
 * never un-makes staff. Returns the team as it was, for Redo.
 */
export function retireTeam(teamId: string): Team | undefined {
  const team = getTeam(teamId);
  if (!team) return undefined;
  if (team.roomChatId) deleteChat(team.roomChatId);
  void save((doc) => ({ ...doc, teams: doc.teams.filter((t) => t.id !== teamId) }));
  return team;
}

/** Redo a team Undo took away: the same team comes back with a fresh room, and its Monos back in it. */
export function restoreTeam(team: Team): Team {
  const have = getTeam(team.id);
  if (have) return have;
  const roomProjectId = team.roomProjectId ?? team.projects[0];
  if (!roomProjectId) throw new Error("That team has no project to put its room in.");
  const room = createChat(roomProjectId, `${team.name} team`, team.memberIds);
  const back: Team = { ...team, roomChatId: room.id, roomProjectId };
  void save(withTeam(back));
  return back;
}

/** A Mono's SOUL.md from its brief: who it is, its lane, and the house rules every named Mono keeps. */
export function soulFromBrief(spec: Pick<MonoSpec, "name" | "brief" | "connectors">, teamName?: string): string {
  const brief = spec.brief.trim().replace(/\s+/g, " ");
  const connectors = spec.connectors.map((id) => catalogEntry(id)?.name ?? id);
  return forUser`# Soul

## Who I am
I'm ${spec.name}${teamName ? `, on the ${teamName} team` : ""}. I'm a named Mono Ash works with directly.

## My lane
${brief || forUser("(Ash will describe this lane.)")}

## How I work
- I stay in my lane, and say so when something belongs to someone else on the team.
- I hand bigger pieces of work to workers (subagents) and check what they bring back before I report it.
- I use only the connectors I've been given${connectors.length ? ` (${connectors.join(", ")})` : " (none yet)"}. If I need another, I ask Ash.
- Before anything leaves for the outside world (a post, an email, a message to a customer, a payment), I show Ash the draft and wait for his go.
- I report briefly: what changed, what I checked, and what needs Ash.

## Standing instructions
- (Add anything it should always keep in mind.)
`;
}

function checkSpec(spec: MonoSpec): MonoSpec {
  const name = cleanName(spec.name, "A Mono");
  if (listMonos().some((m) => monoLook(m).name.toLowerCase() === name.toLowerCase()))
    throw new Error(`A Mono called ${name} already exists.`);
  if (!HARNESSES.includes(spec.engine)) throw new Error(`${String(spec.engine)} isn't an engine MonoCode can run.`);
  const unknown = spec.connectors.filter((id) => !catalogEntry(id));
  if (unknown.length) throw new Error(`No connector called ${unknown.join(", ")}.`);
  if (typeof spec.brief !== "string" || spec.brief.length > 2000) throw new Error("The brief must be under 2000 characters.");
  if (spec.soul !== undefined && (typeof spec.soul !== "string" || spec.soul.length > 24_000))
    throw new Error("The soul must be under 24000 characters.");
  return { ...spec, name, projects: [...new Set(spec.projects)], connectors: [...new Set(spec.connectors)] };
}

/** What making a Mono touches; tests swap these in. */
export type MakeDeps = {
  createMono(projects: string[]): Mono;
  name(monoId: string, name: string): void;
  engine(monoId: string, engine: HarnessId): void;
  writeSoul(monoId: string, soul: string): Promise<void>;
  setConnectors(monoId: string, ids: string[]): Promise<unknown>;
  addToRoom(chatId: string, monoId: string): void;
  /** Take back a Mono whose making failed part way (and any connector choice it got). */
  discard(monoId: string): void;
};

export const appDeps: MakeDeps = {
  createMono: (projects) => createMono(projects),
  name: saveMonoName,
  // A Claude Code Mono starts on the app's default Claude model; another engine starts on its own default.
  engine: (monoId, engine) =>
    void updateMono(monoId, (mono) => {
      const { engineModel: _, ...rest } = mono;
      return { ...rest, engine, ...(engine === "claude" ? { engineModel: defaultClaudeModelId() } : {}) };
    }),
  writeSoul: async (monoId, soul) => {
    const files = await loadMonoFiles(monoId);
    await saveMonoFile(monoId, "soul", soul, files.soulHash);
  },
  // Only these connectors, and only where its projects allow them (connectors/settings.rs decides at launch).
  setConnectors: (monoId, ids) => setMonoConnectors(monoId, { mode: "only", ids }),
  addToRoom: addMember,
  discard: (monoId) => {
    discardNewMono(monoId);
    void setMonoConnectors(monoId, null).catch(() => undefined);
  },
};

/**
 * Make a named Mono now (Ash's own action on Settings > Teams, or his Approve on a proposal). It gets its name, its
 * SOUL, its engine, its projects and only the connectors picked for it, and joins its team and the team room.
 */
export async function addNamedMono(teamId: string | undefined, input: MonoSpec, deps: MakeDeps = appDeps): Promise<Mono> {
  const spec = checkSpec(input);
  const team = teamId ? getTeam(teamId) : undefined;
  if (teamId && !team) throw new Error("That team is gone.");
  const mono = deps.createMono(spec.projects);
  // All or nothing: a Mono left with no connector choice may use everything its projects allow, and a second Approve
  // would fail on its name. Its choice goes first, so it is never without one for long.
  try {
    deps.name(mono.id, spec.name);
    deps.engine(mono.id, spec.engine);
    await deps.setConnectors(mono.id, spec.connectors);
    await deps.writeSoul(mono.id, spec.soul?.trim() ? spec.soul : soulFromBrief(spec, team?.name));
  } catch (error) {
    deps.discard(mono.id);
    throw error;
  }
  if (team) {
    void save((doc) => ({
      ...doc,
      teams: doc.teams.map((t) => (t.id === team.id && !t.memberIds.includes(mono.id) ? { ...t, memberIds: [...t.memberIds, mono.id] } : t)),
    }));
    if (team.roomChatId) deps.addToRoom(team.roomChatId, mono.id);
  }
  return mono;
}

/**
 * An agent proposes a new named Mono. It waits for Ash: listed on Today's Setup and on Settings > Teams with its soul,
 * engine, projects and connectors. Nothing is made until he approves it.
 */
export function proposeMono(
  input: { team?: string; spec: MonoSpec },
  proposedBy: { monoId?: string; name: string },
): MonoProposal {
  const spec = checkSpec(input.spec);
  if (pendingMonoProposals().some((p) => p.spec.name.toLowerCase() === spec.name.toLowerCase()))
    throw new Error(forUser`${spec.name} is already waiting for Ash's okay.`);
  const teamName = input.team?.trim();
  const team = teamName ? current().teams.find((t) => t.name.toLowerCase() === teamName.toLowerCase() || t.id === teamName) : undefined;
  const proposal: MonoProposal = {
    id: `proposal-${crypto.randomUUID().slice(0, 8)}`,
    ...(team ? { teamId: team.id } : teamName ? { teamName: cleanName(teamName, "A team") } : {}),
    spec,
    proposedBy,
    at: new Date().toISOString(),
    status: "pending",
  };
  void save((doc) => (doc.proposals.some((p) => p.id === proposal.id) ? doc : { ...doc, proposals: [...doc.proposals, proposal] }));
  return proposal;
}

/**
 * Ash approves: a proposed team that doesn't exist yet is made (in the hub projects given, its room in the first),
 * then the Mono. Only Ash's tap calls this.
 */
export async function approveProposal(id: string, hubProjects: string[] = [], deps: MakeDeps = appDeps): Promise<Mono> {
  const proposal = current().proposals.find((p) => p.id === id && p.status === "pending");
  if (!proposal) throw new Error("That proposal isn't waiting any more.");
  let teamId = proposal.teamId;
  if (!teamId && proposal.teamName) {
    const existing = current().teams.find((t) => t.name.toLowerCase() === proposal.teamName!.toLowerCase());
    teamId = existing?.id ?? createTeam({ name: proposal.teamName, brief: "", projects: hubProjects }).id;
  }
  const mono = await addNamedMono(teamId, proposal.spec, deps);
  void save((doc) => ({ ...doc, proposals: doc.proposals.map((p) => (p.id === id ? { ...p, status: "approved" as const, monoId: mono.id } : p)) }));
  return mono;
}

export function declineProposal(id: string): void {
  void save((doc) => ({ ...doc, proposals: doc.proposals.map((p) => (p.id === id && p.status === "pending" ? { ...p, status: "declined" as const } : p)) }));
}

/** Project names an agent gave, as folders: one of the hub's (id, name or folder) or one of `own`. */
export function resolveProjects(wanted: readonly string[], own: readonly string[]): string[] {
  const hub = hubData().listProjects();
  return wanted.map((want) => {
    const lower = want.toLowerCase();
    const fromHub = hub.find((p) => p.folder && (p.id.toLowerCase() === lower || p.name.toLowerCase() === lower || projectKey(p.folder) === projectKey(want)));
    if (fromHub?.folder) return fromHub.folder;
    const mine = own.find((path) => projectKey(path) === projectKey(want) || path.split("/").pop()?.toLowerCase() === lower);
    if (mine) return mine;
    throw new Error(`Unknown project ${want}: name one of the hub's projects or one of yours.`);
  });
}

/**
 * `app monos.propose` from a Mono: its fields checked and its project names resolved to folders. A project is one of
 * the hub's (by id or name) or one the proposing Mono already works on; it defaults to the proposer's own projects.
 */
export function proposeMonoFromAgent(
  input: Record<string, unknown>,
  proposer: { monoId: string; projects: readonly string[] },
): MonoProposal {
  const strings = (value: unknown, what: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20 || value.some((v) => typeof v !== "string" || !v.trim() || v.length > 4096))
      throw new Error(`${what} must be an array of at most 20 strings`);
    return value.map((v: string) => v.trim());
  };
  const text = (value: unknown, what: string, max: number): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > max) throw new Error(`${what} must be a string under ${max} characters`);
    return value;
  };
  const own = proposer.projects;
  const projects = resolveProjects(strings(input.projects, "projects"), own);
  const engine = (text(input.engine, "engine", 32) ?? "claude") as HarnessId;
  const lane = text(input.lane, "lane", 2000);
  const brief = text(input.brief, "brief", 2000) ?? "";
  return proposeMono(
    {
      team: text(input.team, "team", 40),
      spec: {
        name: text(input.name, "name", 40) ?? "",
        brief: lane ? `${brief}\n${lane}`.trim() : brief,
        engine,
        projects: projects.length ? projects : [...own],
        connectors: strings(input.connectors, "connectors"),
        ...(input.soul !== undefined ? { soul: text(input.soul, "soul", 24_000) } : {}),
      },
    },
    { monoId: proposer.monoId, name: monoName(proposer.monoId) },
  );
}

function monoName(monoId: string): string {
  const mono = listMonos().find((m) => m.id === monoId);
  return mono ? monoLook(mono).name : "A Mono";
}

export function engineTitle(engine: HarnessId): string {
  return HARNESS_TITLE[engine] ?? engine;
}

export function openTeamRoom(team: Team): void {
  if (!team.roomChatId || !team.roomProjectId) return;
  window.dispatchEvent(new CustomEvent(OPEN_HUB_EVENT, { detail: { project: team.roomProjectId, item: `chat:${team.roomChatId}` } }));
}

export function openTeamsSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_TEAMS_EVENT));
}
