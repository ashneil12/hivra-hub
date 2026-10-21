import { addMember } from "../../hub/model/hubChats";
import { recordMadeMono } from "../../hub/model/botChanges";
import { addNamedMono, appDeps, resolveProjects, type MakeDeps } from "../../hub/model/hubTeams";
import { listMonos, monoLook, saveMonoRole } from "../../monos/model/mono";
import { ASK_ASH_FIRST } from "./ashSaid";
import SOUL_TEMPLATE from "../templates/SOUL.md?raw";

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

/**
 * A new Mono's SOUL.md is the short shape in templates/SOUL.md: its role, who it is and what it watches for, and its
 * skills. Nothing on how it talks, its tone or its format: those come from the hub, not from each soul.
 */
const SOUL_SECTIONS = ["role", "who i am", "skills"];
function sections(soul: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of soul.split(/^##\s+/m).slice(1)) {
    const [head, ...body] = part.split("\n");
    out.set(head.trim().toLowerCase(), body.join("\n").trim());
  }
  return out;
}
export function draftSoul(parts: { role: string; who: string; skills: string[] }): string {
  const skills = parts.skills.length ? parts.skills.map((s) => `- ${s}`).join("\n") : "- (none yet)";
  return SOUL_TEMPLATE.replace("{{role}}", parts.role).replace("{{who}}", parts.who).replace("{{skills}}", skills);
}
/** The soul in the short shape, from the Mono's own SOUL.md or from role and who. Refused in plain words otherwise. */
function shortSoul(input: { name: string; role?: string; who?: string; soul?: string; skills: string[] }): string {
  const given = input.soul ? sections(input.soul) : new Map<string, string>();
  const extra = [...given.keys()].filter((h) => !SOUL_SECTIONS.includes(h));
  if (extra.length)
    throw new Error(`Keep the soul to the short shape: ## Role, ## Who I am, ## Skills. Leave out ${extra.map((h) => `"${h}"`).join(", ")}: how it talks, its tone and format aren't part of a soul.`);
  const role = given.get("role") || input.role;
  const who = given.get("who i am") || input.who;
  if (!role || !who) throw new Error("Give its role (one line) and who it is and what it watches for (who), or a soul with ## Role and ## Who I am.");
  const listed = (given.get("skills") ?? "").split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter((l) => l && l !== "(none yet)");
  return draftSoul({ role: role.split("\n")[0].trim(), who, skills: [...new Set([...listed, ...input.skills])] });
}

/** Draft one Mono: checked now, nothing made. Returns what to show Ash. */
export function draftMono(
  input: Record<string, unknown>,
  caller: { monoId: string; name: string; projects: readonly string[] },
  now = Date.now(),
): { draftId: string; plan: { name: string; role?: string; soul: string; skills: string[] }; note: string } {
  const name = text(input.name, "name", 40, true)!;
  if (listMonos().some((m) => monoLook(m).name.toLowerCase() === name.toLowerCase())) throw new Error(`A Mono called ${name} already exists.`);
  const role = text(input.role, "role", 40) ?? (typeof input.soul === "string" ? sections(input.soul).get("role")?.split("\n")[0].trim().slice(0, 40) || undefined : undefined);
  const skills = strings(input.skills, "skills", 12);
  const given = text(input.soul, "soul", 24_000);
  const who = text(input.who, "who", 1200);
  const connectors = strings(input.connectors, "connectors");
  const soul = shortSoul({ name, ...(role ? { role } : {}), ...(who ? { who } : {}), ...(given ? { soul: given } : {}), skills });
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
    // What Ash is shown: its name, role line and who it is (the soul's "Who I am"), and its skills.
    plan: { name, ...(role ? { role } : {}), soul: sections(soul).get("who i am") ?? "", skills: sections(soul).get("skills")?.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter((l) => l && l !== "(none yet)") ?? [] },
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
