import { addMember } from "../../hub/model/hubChats";
import { recordMadeMono } from "../../hub/model/botChanges";
import { addNamedMono, appDeps, resolveProjects, soulFromBrief, type MakeDeps } from "../../hub/model/hubTeams";
import { listMonos, monoLook, saveMonoRole } from "../../monos/model/mono";
import { ASK_ASH_FIRST } from "./ashSaid";

/**
 * A Mono makes a new Mono with Ash, Dr Eggbot style (ash-day step 13): it asks him a few questions, drafts the one
 * Mono (`draftMono`), shows it to him, and makes it on his yes (`makeDrafted`). No approval card: his yes in the chat
 * is the okay, and the app only checks he answered after the draft. One draft makes one Mono, however often it is
 * called; Undo in Bot changes retires it again.
 */
export type MonoDraft = {
  id: string;
  at: number;
  by: { monoId: string; name: string };
  name: string;
  role?: string;
  soul: string;
  projects: string[];
  connectors: string[];
  rooms: string[];
  /** Set once made: the same draft never makes a second Mono. */
  madeId?: string;
};

const KEY = "monocode:mono-drafts";
function load(): MonoDraft[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as MonoDraft[];
    return Array.isArray(list) ? list.filter((d) => d && typeof d.id === "string") : [];
  } catch {
    return [];
  }
}
function save(list: MonoDraft[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-20)));
  } catch {
    /* best effort */
  }
}

function text(value: unknown, what: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${what} must be text under ${max} characters`);
  return value.trim();
}
function strings(value: unknown, what: string, max = 20): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== "string" || !v.trim() || v.length > 300))
    throw new Error(`${what} must be a list of at most ${max} short strings`);
  return value.map((v: string) => v.trim());
}

/** The soul with its skills listed, when the Mono gave skills its soul doesn't already name. */
function withSkills(soul: string, skills: string[]): string {
  if (!skills.length || /^##\s+skills\b/im.test(soul)) return soul;
  return `${soul.trimEnd()}\n\n## Skills\n${skills.map((s) => `- ${s}`).join("\n")}\n`;
}

/** Draft one Mono: checked now, nothing made. Returns what to show Ash. */
export function draftMono(
  input: Record<string, unknown>,
  caller: { monoId: string; name: string; projects: readonly string[] },
  now = Date.now(),
): { draftId: string; plan: { name: string; role?: string; soul: string }; note: string } {
  const name = text(input.name, "name", 40, true)!;
  if (listMonos().some((m) => monoLook(m).name.toLowerCase() === name.toLowerCase())) throw new Error(`A Mono called ${name} already exists.`);
  const role = text(input.role, "role", 40);
  const skills = strings(input.skills, "skills", 12);
  const given = text(input.soul, "soul", 24_000);
  const connectors = strings(input.connectors, "connectors");
  const soul = withSkills(given ?? soulFromBrief({ name, brief: role ?? "", connectors }), skills);
  const projects = resolveProjects(strings(input.projects, "projects"), caller.projects);
  const drafts = load().filter((d) => d.madeId || d.name.toLowerCase() !== name.toLowerCase());
  const draft: MonoDraft = {
    id: `draft-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: now,
    by: { monoId: caller.monoId, name: caller.name },
    name,
    ...(role ? { role } : {}),
    soul,
    projects: projects.length ? projects : [...caller.projects],
    connectors,
    rooms: strings(input.rooms, "rooms", 10),
  };
  save([...drafts, draft]);
  return {
    draftId: draft.id,
    plan: { name, ...(role ? { role } : {}), soul: soul.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 4).join(" ") },
    note: "Nothing is made yet. Show Ash this one Mono in a short message (name, role line, two or three lines of who it is) and end your turn. After his yes, call mono_create with only draftId.",
  };
}

export type MakeHost = {
  /** Ash said something to the caller since this time (ashSaid.ts). */
  ashSpokeSince(since: number): boolean;
  /** A room of the caller's by id or name (agentAppRooms.resolveRoom). */
  room(ref: string): { id: string; name: string };
  deps?: MakeDeps;
};

/** Make the drafted Mono, once Ash has answered. */
export async function makeDrafted(draftId: unknown, caller: { monoId: string }, host: MakeHost) {
  if (typeof draftId !== "string" || !draftId) throw new Error("draftId must be the id mono_create gave you");
  const drafts = load();
  const draft = drafts.find((d) => d.id === draftId && d.by.monoId === caller.monoId);
  if (!draft) throw new Error("No draft with that id from you. Draft it again with name, role and soul.");
  if (draft.madeId) {
    const made = listMonos().find((m) => m.id === draft.madeId);
    return { made: draft.name, monoId: draft.madeId, alreadyMade: true, ...(made ? {} : { note: "It was made, then undone in Bot changes." }) };
  }
  if (!host.ashSpokeSince(draft.at)) throw new Error(ASK_ASH_FIRST);
  const rooms = draft.rooms.map((r) => host.room(r));
  const mono = await addNamedMono(undefined, { name: draft.name, brief: draft.role ?? "", engine: "claude", projects: draft.projects, connectors: draft.connectors, soul: draft.soul }, host.deps ?? appDeps);
  if (draft.role) saveMonoRole(mono.id, draft.role);
  for (const room of rooms) addMember(room.id, mono.id);
  save(load().map((d) => (d.id === draft.id ? { ...d, madeId: mono.id } : d)));
  recordMadeMono(mono.id, draft.by.name, draft.name, draft.role);
  return {
    made: draft.name,
    monoId: mono.id,
    ...(draft.role ? { role: draft.role } : {}),
    ...(rooms.length ? { rooms: rooms.map((r) => r.name) } : {}),
    note: `${draft.name} is in the sidebar now, with Undo in Bot changes. Tell Ash in one line; greet it with mono_message if he wants to hear it.`,
  };
}
