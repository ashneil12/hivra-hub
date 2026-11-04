// WP-21: Monos as contacts. Pin, mute, duplicate and profile live on the roster. Soul files are copied only
// under a safe id, and never back onto the original.

import { invoke } from "@tauri-apps/api/core";
import { addStarterMono } from "../../hub/model/starterMonos";
import { readAgentFile, writeAgentFile } from "./monoFiles";
import {
  commitRoster,
  createMono,
  defaultMonoName,
  discardNewMono,
  findMono,
  listMonos,
  monoRole,
  removeMonoIfCurrent,
  updateMono,
  type Mono,
  type RosterCommit,
} from "./mono";

const SAFE_ID = /^[A-Za-z0-9-]+$/;

export type ContactActivity = { lastLine?: unknown; unread?: unknown };

export type ContactRow = {
  id: string;
  name: string;
  title: string;
  lastLine: string;
  unread: number;
  pinned: boolean;
  muted: boolean;
};

/** One line, no control characters. Empty stays empty so the row can say there are no messages yet. */
export function contactLastLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[0] ?? "";
  return line.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 160);
}

/** A mute hides the badge. Anything that is not a positive count is zero. Over 99 still counts as 99 on the row. */
export function contactUnread(value: unknown, muted: boolean): number {
  if (muted) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(99, Math.floor(value));
}

/** Pinned first. Everyone else keeps the roster order. */
export function contactRows(
  monos: readonly Mono[],
  activity: Readonly<Record<string, ContactActivity>> = {},
): ContactRow[] {
  return monos
    .map((mono, index) => ({ mono, index }))
    .sort((a, b) => Number(b.mono.pinned === true) - Number(a.mono.pinned === true) || a.index - b.index)
    .map(({ mono }) => {
      const extra = activity[mono.id] ?? {};
      const muted = mono.muted === true;
      const last = contactLastLine(extra.lastLine);
      const role = monoRole(mono);
      return {
        id: mono.id,
        name: mono.name?.trim() || defaultMonoName(mono.mascot),
        title: role ?? "",
        lastLine: last || "No messages yet",
        unread: contactUnread(extra.unread, muted),
        pinned: mono.pinned === true,
        muted,
      };
    });
}

/** Shown when a pin, mute, rename or remove did not stay on the roster. */
export const CONTACT_SAVE_LOST = "That save didn't land. Try again.";

let lastWrite: RosterCommit = "saved";

/** The last pin, mute, rename or remove: saved, lost, or the contact was not there. */
export function contactWriteResult(): RosterCommit {
  return lastWrite;
}

function note(result: RosterCommit): void {
  lastWrite = result;
}

/** Change one contact only when the roster is still the one just read, then read it back. */
function commitContact(id: string, change: (mono: Mono) => Mono): Mono | undefined {
  if (!SAFE_ID.test(id)) {
    note("missing");
    return undefined;
  }
  const result = commitRoster((roster) => {
    const index = roster.findIndex((mono) => mono.id === id);
    if (index < 0) return null;
    const next = roster.slice();
    const mono = change({ ...next[index] });
    if (!mono.name?.trim()) delete mono.name;
    if (!mono.instructions?.trim()) delete mono.instructions;
    next[index] = mono;
    return next;
  });
  note(result);
  return result === "saved" ? findMono(id) : undefined;
}

function withFlag(id: string, flag: "pinned" | "muted", on: boolean): Mono | undefined {
  return commitContact(id, (mono) => {
    const next = { ...mono };
    if (on) next[flag] = true;
    else delete next[flag];
    return next;
  });
}

export function setContactPinned(id: string, pinned: boolean): Mono | undefined {
  return withFlag(id, "pinned", pinned);
}

export function setContactMuted(id: string, muted: boolean): Mono | undefined {
  return withFlag(id, "muted", muted);
}

function copyName(mono: Mono): string {
  const base = (mono.name?.trim() || defaultMonoName(mono.mascot)).replace(/[\r\n]/g, " ").trim().slice(0, 60);
  return `${base} copy`.slice(0, 70);
}

/**
 * A second contact with the same look, name and role. It does not share a chat. The original is not changed.
 * Gone already: nothing is added.
 */
export function duplicateContact(id: string): Mono | undefined {
  if (!SAFE_ID.test(id)) return undefined;
  const source = findMono(id);
  if (!source) return undefined;
  const created = createMono(source.projects);
  const saved = updateMono(created.id, (mono) => ({
    ...mono,
    name: copyName(source),
    mascot: source.mascot,
    color: source.color,
    ...(source.mascotPicked ? { mascotPicked: true } : {}),
    ...(source.role !== undefined ? { role: source.role } : {}),
    ...(source.instructions ? { instructions: source.instructions } : {}),
  }));
  if (!saved) {
    discardNewMono(created.id);
    return undefined;
  }
  const copy = findMono(created.id);
  if (copy?.sessionId) return undefined;
  return copy;
}

export type ProfileFile = "SOUL.md" | "MEMORY.md";
export type ContactFileName = ProfileFile | `skills/${string}.md`;

export type ContactFileOps = {
  read(id: string, name: ContactFileName): Promise<string | null>;
  write(id: string, name: ContactFileName, text: string): Promise<boolean>;
  /** Skill names, without `.md`. Missing means this copy has no skill list. */
  listSkills?(id: string): Promise<readonly string[]>;
};

/** A skill file name Rust would accept, and not a path. `..`, a slash or a leading dot is refused. */
export function skillFileName(name: string): `skills/${string}.md` | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80 || trimmed.startsWith(".")) return null;
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (![...trimmed].every((char) => /[A-Za-z0-9 ._-]/.test(char))) return null;
  return `skills/${trimmed}.md`;
}

/**
 * Copy the original's soul, memory and skills onto the new contact. Refuses a bad id, a copy onto itself, or a
 * contact that has gone. The writer is never asked to write the original.
 */
export async function duplicateContactFiles(
  fromId: string,
  toId: string,
  files: ContactFileOps,
): Promise<"copied" | "skipped" | "retry"> {
  if (!SAFE_ID.test(fromId) || !SAFE_ID.test(toId) || fromId === toId) return "skipped";
  if (!findMono(fromId) || !findMono(toId)) return "skipped";
  let wrote = false;
  const names: ContactFileName[] = ["SOUL.md", "MEMORY.md"];
  if (files.listSkills) {
    let skills: readonly string[] = [];
    try {
      skills = await files.listSkills(fromId);
    } catch {
      skills = [];
    }
    for (const skill of skills) {
      const path = skillFileName(skill);
      if (path) names.push(path);
    }
  }
  for (const name of names) {
    const text = await files.read(fromId, name);
    if (!findMono(toId)) return wrote ? "retry" : "skipped";
    if (text == null) continue;
    const landed = await files.write(toId, name, text);
    if (!landed) return "retry";
    wrote = true;
  }
  return wrote ? "copied" : "skipped";
}

function appContactFiles(): ContactFileOps {
  return {
    read: async (id, name) => {
      try {
        return (await readAgentFile(id, name)).text;
      } catch {
        return null;
      }
    },
    write: async (id, name, text) => {
      try {
        await writeAgentFile(id, name, text);
        return true;
      } catch {
        return false;
      }
    },
    listSkills: async (id) => {
      try {
        const loaded = await invoke<{ skills?: unknown }>("mono_load", {
          mono: id,
          legacyProject: findMono(id)?.legacyProject ?? null,
        });
        return Array.isArray(loaded?.skills) ? loaded.skills.filter((skill): skill is string => typeof skill === "string") : [];
      } catch {
        return [];
      }
    },
  };
}

/**
 * The app's duplicate: a new contact, then its soul, memory and skills. The original is not written.
 * Gone already: nothing is added.
 */
export async function duplicateContactWithFiles(id: string, files: ContactFileOps = appContactFiles()): Promise<Mono | undefined> {
  const copy = duplicateContact(id);
  if (!copy) return undefined;
  await duplicateContactFiles(id, copy.id, files);
  return findMono(copy.id);
}

export function editContactProfile(id: string, profile: { name?: unknown; title?: unknown }): Mono | undefined {
  const clean = (value: string, max: number) => value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const name = typeof profile.name === "string" ? clean(profile.name, 80) : undefined;
  const title = typeof profile.title === "string" ? clean(profile.title, 40) : undefined;
  return commitContact(id, (mono) => ({
    ...mono,
    ...(name !== undefined ? { name } : {}),
    ...(title !== undefined ? { role: title } : {}),
  }));
}

/** Removes the roster entry. The folder of files stays. A bad id, or one already gone, removes nothing. */
export function removeContact(id: string): boolean {
  if (!SAFE_ID.test(id)) {
    note("missing");
    return false;
  }
  const result = removeMonoIfCurrent(id);
  note(result);
  return result === "saved";
}

export function newContact(projects: readonly string[] = []): Mono {
  return createMono(projects);
}

/** A template id the plugin doesn't know adds nothing. */
export function newContactFromTemplate(templateId: string, projects: readonly string[] = []): Mono | undefined {
  if (!SAFE_ID.test(templateId)) return undefined;
  return addStarterMono(templateId, projects);
}

/** Rows for the roster as it is now. */
export function listContactRows(activity: Readonly<Record<string, ContactActivity>> = {}): ContactRow[] {
  return contactRows(listMonos(), activity);
}
