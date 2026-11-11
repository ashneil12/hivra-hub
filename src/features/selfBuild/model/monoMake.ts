import { addMember } from "../../hub/model/hubChats";
import { recordMadeMono } from "../../hub/model/botChanges";
import {
  addNamedMono,
  appDeps,
  resolveProjects,
  type MakeDeps,
} from "../../hub/model/hubTeams";
import { useSyncExternalStore } from "react";
import {
  listMonos,
  monoLook,
  nextMonoLook,
  saveMonoRole,
  updateMono,
} from "../../monos/model/mono";
import { ASK_ASH_FIRST } from "./ashSaid";
import SOUL_TEMPLATE from "../templates/SOUL.md?raw";
import { forUser } from "../../hub/model/userName";
import { isChiefOfStaffName } from "../../chief/model/charter";

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
  /** The creature and colour it gets, picked when drafted so the card shows what the sidebar will. */
  look?: { mascot: string; color: string };
  /** Ash waved it off on the card: it isn't shown again (the Mono can still draft another). */
  dismissed?: boolean;
  /** When he did (r48): the drafting Mono is told, so it never takes the card for one still waiting. */
  dismissedAt?: number;
  /** Set once made: the same draft never makes a second Mono. */
  madeId?: string;
  /**
   * The chat it was drafted in, where its card sits as a message (r29): a group chat's conversation when the Mono was
   * taking its turn there, else the Mono's own chat. Drafts from before r29 have none: they show in the Mono's own chat.
   */
  where?: DraftPlace;
};
export type DraftPlace = { room: string; conv?: string } | { session: string };

/** The waiting drafts whose card belongs in this chat. */
export function draftsIn(
  drafts: readonly MonoDraft[],
  place: { room: string; conv?: string } | { session: string; monoId?: string },
): MonoDraft[] {
  return drafts.filter((d) => {
    const w = d.where;
    if ("room" in place) return !!w && "room" in w && w.room === place.room && (!w.conv || !place.conv || w.conv === place.conv);
    if (w) return "session" in w && w.session === place.session;
    return !!place.monoId && d.by.monoId === place.monoId;
  });
}

const KEY = "monocode:mono-drafts";
function load(): MonoDraft[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as MonoDraft[];
    return Array.isArray(list)
      ? list.filter((d) => d && typeof d.id === "string")
      : [];
  } catch {
    return [];
  }
}
let version = 0;
const subs = new Set<() => void>();
function save(list: MonoDraft[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-20)));
  } catch {
    /* best effort */
  }
  version++;
  subs.forEach((f) => f());
}
/** The drafts waiting on Ash's yes, newest last: the draft card at the top of the window shows them (ChangeBar). */
export function waitingDrafts(): MonoDraft[] {
  return load().filter((d) => !d.madeId && !d.dismissed);
}
export function useWaitingDrafts(): MonoDraft[] {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return waitingDrafts();
}
/** Not this one: the card goes; nothing was made. */
export function dismissDraft(id: string, now = Date.now()): void {
  save(load().map((d) => (d.id === id ? { ...d, dismissed: true, dismissedAt: now } : d)));
}

/** How long a Mono hears about its own cards after drafting them. */
const CARD_NEWS_MS = 3 * 24 * 60 * 60_000;
const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * The Mono cards this Mono drafted lately, each with what really happened to it (r48: in a new conversation CoS said
 * "the card at the top" of one Ash had turned down an hour before, and took his fresh ask as already done). A made one
 * is a Mono in the sidebar, so it isn't listed. `here` is the chat the turn is in: a waiting card elsewhere says so.
 */
export function draftStatusLines(monoId: string, here?: DraftPlace, now = Date.now()): string[] {
  return load()
    .filter((d) => d.by.monoId === monoId && !d.madeId && now - d.at < CARD_NEWS_MS)
    .map((d) => {
      if (d.dismissed) return `"${d.name}": turned down by Ash ("Not this one")${d.dismissedAt ? ` at ${clock(d.dismissedAt)}` : ""}; nothing was made and no card shows.`;
      const shownHere = !!here && draftsIn([d], "room" in here ? here : { session: here.session, monoId }).length > 0;
      return `"${d.name}": waiting on Ash's yes; its card shows ${shownHere ? "in this chat" : "in another chat, not this one"}.`;
    });
}
/** The soul's words as Ash reads them on the card: he's "you" there ("draft each one for your OK"); the soul keeps "Ash". */
export function toAsh(text: string): string {
  return text
    .replace(/(^|[.!?]\s+)Ash's\b/g, "$1Your")
    .replace(/\bAsh's\b/g, "your")
    .replace(/\b(for|to|with|by|tell|ask|show|asks|tells|shows) Ash\b/g, "$1 you");
}
/** What the card shows of a draft's soul, in Ash's own second person. */
export function draftCard(d: MonoDraft): { who: string; watchFor: string; skills: string[] } {
  return {
    who: toAsh(sections(d.soul).get("who i am") ?? ""),
    watchFor: toAsh(sections(d.soul).get("what i watch for") ?? ""),
    skills: skillsOf(d.soul),
  };
}

function text(
  value: unknown,
  what: string,
  max: number,
  required = false,
): string | undefined {
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

/**
 * A new Mono's SOUL.md is the short shape in templates/SOUL.md: its role, who it is, what it watches for, and its
 * skills. No tone or format section: the hub adds no style rules of its own. What Ash himself says about how it
 * should sound ("casual") is his and is kept, as his words in ## Who I am.
 */
const SOUL_SECTIONS = ["role", "who i am", "what i watch for", "skills"];
function sections(soul: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of soul.split(/^##\s+/m).slice(1)) {
    const [head, ...body] = part.split("\n");
    out.set(head.trim().toLowerCase(), body.join("\n").trim());
  }
  return out;
}
function skillsOf(soul: string): string[] {
  return (sections(soul).get("skills") ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l && l !== "(none yet)");
}
export function draftSoul(parts: {
  role: string;
  who: string;
  watchFor: string;
  skills: string[];
}): string {
  const skills = parts.skills.length
    ? parts.skills.map((s) => `- ${s}`).join("\n")
    : "- (none yet)";
  return SOUL_TEMPLATE.replace("{{role}}", parts.role)
    .replace("{{who}}", parts.who)
    .replace("{{watchFor}}", parts.watchFor)
    .replace("{{skills}}", skills);
}
/** The soul in the short shape, from the Mono's own SOUL.md or from role, who and watchFor. Refused in plain words otherwise. */
function shortSoul(input: {
  name: string;
  role?: string;
  who?: string;
  watchFor?: string;
  soul?: string;
  skills: string[];
}): string {
  const given = input.soul ? sections(input.soul) : new Map<string, string>();
  const extra = [...given.keys()].filter((h) => !SOUL_SECTIONS.includes(h));
  if (extra.length)
    throw new Error(
      forUser`Keep the soul to the short shape: ## Role, ## Who I am, ## What I watch for, ## Skills. Leave out ${extra.map((h) => `"${h}"`).join(", ")}: no tone or format sections. If Ash said how it should sound, put his words in ## Who I am.`,
    );
  const role = given.get("role") || input.role;
  const who = given.get("who i am") || input.who;
  const watchFor = given.get("what i watch for") || input.watchFor;
  if (!role || !who || !watchFor)
    throw new Error(
      "Give its role (one line), who it is (who) and what it watches for (watchFor), or a soul with ## Role, ## Who I am and ## What I watch for.",
    );
  const listed = (given.get("skills") ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l && l !== "(none yet)");
  return draftSoul({
    role: role.split("\n")[0].trim(),
    who,
    watchFor,
    skills: [...new Set([...listed, ...input.skills])],
  });
}

/** Draft one Mono: checked now, nothing made. Returns what to show Ash. */
export function draftMono(
  input: Record<string, unknown>,
  caller: { monoId: string; name: string; projects: readonly string[] },
  now = Date.now(),
  /** The skills that exist here (the app's skill catalog). Every listed skill must be one of them. */
  knownSkills?: ReadonlySet<string>,
  /** The chat it is drafted in: its card sits there, in the messages. */
  where?: DraftPlace,
): {
  draftId: string;
  plan: {
    name: string;
    role?: string;
    soul: string;
    watchFor: string;
    skills: string[];
  };
  note: string;
} {
  const name = text(input.name, "name", 40, true)!;
  if (isChiefOfStaffName(name)) throw new Error("Chief of Staff is the captain's name. Pick another.");
  if (
    listMonos().some(
      (m) => monoLook(m).name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error(`A Mono called ${name} already exists.`);
  const role =
    text(input.role, "role", 40) ??
    (typeof input.soul === "string"
      ? sections(input.soul).get("role")?.split("\n")[0].trim().slice(0, 40) ||
        undefined
      : undefined);
  const skills = strings(input.skills, "skills", 12);
  const given = text(input.soul, "soul", 24_000);
  const who = text(input.who, "who", 1200);
  const watchFor = text(input.watchFor, "watchFor", 1200);
  const connectors = strings(input.connectors, "connectors");
  const soul = shortSoul({
    name,
    ...(role ? { role } : {}),
    ...(who ? { who } : {}),
    ...(watchFor ? { watchFor } : {}),
    ...(given ? { soul: given } : {}),
    skills,
  });
  const listed = skillsOf(soul);
  if (knownSkills) {
    const unknown = listed.filter((s) => !knownSkills.has(s));
    if (unknown.length) {
      const have = [...knownSkills].sort().slice(0, 40).join(", ");
      throw new Error(
        `No skill called ${unknown.join(", ")} is installed. List only skills that exist${have ? `: ${have}` : " (none are installed)"}; leave skills out if none fit.`,
      );
    }
  }
  const projects = resolveProjects(
    strings(input.projects, "projects"),
    caller.projects,
  );
  const drafts = load().filter(
    (d) => d.madeId || d.name.toLowerCase() !== name.toLowerCase(),
  );
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
    look: nextMonoLook(),
    ...(where ? { where } : {}),
  };
  save([...drafts, draft]);
  return {
    draftId: draft.id,
    // What Ash is shown: its name, role line, who it is, what it watches for, and its skills.
    plan: {
      name,
      ...(role ? { role } : {}),
      soul: sections(soul).get("who i am") ?? "",
      watchFor: sections(soul).get("what i watch for") ?? "",
      skills: listed,
    },
    note: forUser("Nothing is made yet. Ash sees the draft card (its creature, name, role, who it is, what it watches for, skills) in this chat, under your message. Tell him in a line or two that it's ready for his yes, and end your turn. The card has no yes button: its only button is \"Not this one\", and it tells him to say yes in the chat. So never tell him to click, tap or press it; ask for his yes here in the chat. After his yes, call mono_create with only draftId. The card is there only until he answers it: once he turns it down or it is made it is gone, so never point him to it after that."),
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
export async function makeDrafted(
  draftId: unknown,
  caller: { monoId: string },
  host: MakeHost,
) {
  if (typeof draftId !== "string" || !draftId)
    throw new Error("draftId must be the id mono_create gave you");
  const drafts = load();
  const draft = drafts.find(
    (d) => d.id === draftId && d.by.monoId === caller.monoId,
  );
  if (!draft)
    throw new Error(
      "No draft with that id from you. Draft it again with name, role and soul.",
    );
  if (draft.dismissed && !draft.madeId)
    throw new Error(
      forUser`Ash turned this card down ("Not this one"), so nothing was made. Draft a new one only if he asks again.`,
    );
  if (draft.madeId) {
    const made = listMonos().find((m) => m.id === draft.madeId);
    return {
      made: draft.name,
      monoId: draft.madeId,
      alreadyMade: true,
      ...(made ? {} : { note: "It was made, then undone in Bot changes." }),
    };
  }
  if (!host.ashSpokeSince(draft.at)) throw new Error(forUser(ASK_ASH_FIRST));
  const rooms = draft.rooms.map((r) => host.room(r));
  const mono = await addNamedMono(
    undefined,
    {
      name: draft.name,
      brief: draft.role ?? "",
      engine: "claude",
      projects: draft.projects,
      connectors: draft.connectors,
      soul: draft.soul,
    },
    host.deps ?? appDeps,
  );
  if (draft.role) saveMonoRole(mono.id, draft.role);
  // The creature and colour Ash saw on the card.
  const look = draft.look;
  if (look)
    updateMono(mono.id, (m) => ({
      ...m,
      mascot: look.mascot,
      color: look.color,
    }));
  for (const room of rooms) addMember(room.id, mono.id);
  save(load().map((d) => (d.id === draft.id ? { ...d, madeId: mono.id } : d)));
  recordMadeMono(mono.id, draft.by.name, draft.name, draft.role);
  return {
    made: draft.name,
    monoId: mono.id,
    ...(draft.role ? { role: draft.role } : {}),
    ...(rooms.length ? { rooms: rooms.map((r) => r.name) } : {}),
    note: forUser`${draft.name} is in the sidebar now, with Undo in Bot changes. Tell Ash in one line; greet it with mono_message if he wants to hear it.`,
  };
}
