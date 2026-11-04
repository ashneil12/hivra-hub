// WP-21: Monos as contacts. Pin, mute, duplicate and profile live on the roster. Soul files are copied only
// under a safe id, and never back onto the original.

import { addStarterMono } from "../../hub/model/starterMonos";
import {
  createMono,
  defaultMonoName,
  discardNewMono,
  findMono,
  listMonos,
  monoRole,
  removeMono,
  updateMono,
  type Mono,
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

function withFlag(id: string, flag: "pinned" | "muted", on: boolean): Mono | undefined {
  if (!SAFE_ID.test(id)) return undefined;
  return updateMono(id, (mono) => {
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

/**
 * Copy the original's soul and memory onto the new contact. Refuses a bad id, a copy onto itself, or a contact
 * that has gone. The writer is never asked to write the original.
 */
export async function duplicateContactFiles(
  fromId: string,
  toId: string,
  files: {
    read(id: string, name: ProfileFile): Promise<string | null>;
    write(id: string, name: ProfileFile, text: string): Promise<boolean>;
  },
): Promise<"copied" | "skipped" | "retry"> {
  if (!SAFE_ID.test(fromId) || !SAFE_ID.test(toId) || fromId === toId) return "skipped";
  if (!findMono(fromId) || !findMono(toId)) return "skipped";
  let wrote = false;
  for (const name of ["SOUL.md", "MEMORY.md"] as const) {
    const text = await files.read(fromId, name);
    if (!findMono(toId)) return wrote ? "retry" : "skipped";
    if (text == null) continue;
    const landed = await files.write(toId, name, text);
    if (!landed) return "retry";
    wrote = true;
  }
  return wrote ? "copied" : "skipped";
}

export function editContactProfile(id: string, profile: { name?: unknown; title?: unknown }): Mono | undefined {
  if (!SAFE_ID.test(id) || !findMono(id)) return undefined;
  const clean = (value: string, max: number) => value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const name = typeof profile.name === "string" ? clean(profile.name, 80) : undefined;
  const title = typeof profile.title === "string" ? clean(profile.title, 40) : undefined;
  return updateMono(id, (mono) => ({
    ...mono,
    ...(name !== undefined ? { name } : {}),
    ...(title !== undefined ? { role: title } : {}),
  }));
}

/** Removes the roster entry. The folder of files stays. A bad id, or one already gone, removes nothing. */
export function removeContact(id: string): boolean {
  if (!SAFE_ID.test(id) || !findMono(id)) return false;
  removeMono(id);
  return !findMono(id);
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
