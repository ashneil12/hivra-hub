// The project filter on the Chief of Staff's one chat (Ash's round 3 pick, 13 Nov: one chat for every project, with a
// lens that narrows the SAME chat to one project and makes the next message about it). Nothing is removed and no second
// chat is made: "Everything" shows the whole chat again.
//
// How a turn is told apart (Ash 15:25: "curious how the project filter tells things apart"), most exact first:
//  1. A message he typed while narrowed carries that project (`Block.lensProject`).
//  2. The app's own cards carry it: a catch-up's rows, a roll-up's items, the chat a "You messaged" line went to.
//  3. A question linked in a reply (`hivra://local/need/…`) and a linked chat carry their project.
//  4. Otherwise a project's name, or its first mate's name, in the words of the message or the reply.
// A turn shows under every project it touches; a turn that touches none shows only under Everything.
import { useSyncExternalStore } from "react";
import type { Block } from "../../sessions/model/session";
import { needKeyOf } from "./needLinks";

export type LensProject = { id: string; name: string; folder?: string | null; mates?: readonly string[] };

export type LensLookup = {
  projects: readonly LensProject[];
  /** The project of an open Needs you item, by its key. */
  needProject?: (key: string) => string | undefined;
  /** The project a chat belongs to, by its id. */
  chatProject?: (chatId: string) => string | undefined;
};

let lens: string | null = null;
const listeners = new Set<() => void>();

/** Which project the one chat is narrowed to; null is everything. */
export function chiefLens(): string | null {
  return lens;
}

export function setChiefLens(next: string | null): void {
  const value = next?.trim() || null;
  if (value === lens) return;
  lens = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChiefLens(): string | null {
  return useSyncExternalStore(subscribe, chiefLens, () => null);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = new Map<string, RegExp>();

/** The name as a whole word, any case: "EXO" finds "exo's build", not "exoskeleton". */
function wordPattern(name: string): RegExp | undefined {
  const word = name.replace(/\s+/g, " ").trim();
  if (word.length < 2) return undefined;
  let pattern = patterns.get(word);
  if (!pattern) {
    pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(word).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu");
    if (patterns.size > 500) patterns.clear();
    patterns.set(word, pattern);
  }
  return pattern;
}

const LINK = /hivra:\/\/local\/(need|chat)\/([^\s)\]>"']+)/gi;

/** The projects a piece of text names: its links first, then project and first mate names. */
export function textProjects(text: string | undefined, lookup: LensLookup): Set<string> {
  const found = new Set<string>();
  if (!text?.trim()) return found;
  for (const match of text.matchAll(LINK)) {
    const [href, kind, id] = match;
    const project =
      kind.toLowerCase() === "need"
        ? (() => {
            const key = needKeyOf(href);
            return key ? lookup.needProject?.(key) : undefined;
          })()
        : (() => {
            try {
              return lookup.chatProject?.(decodeURIComponent(id));
            } catch {
              return undefined;
            }
          })();
    if (project) found.add(project);
  }
  // Names are read in the words only: a link's address ("hivra://…", a web page) names nothing.
  const words = text.replace(/\b(?:hivra|https?|file):\/\/[^\s)\]>"']*/gi, " ");
  for (const project of lookup.projects) {
    if (found.has(project.id)) continue;
    const names = [project.name, ...(project.mates ?? [])];
    if (names.some((name) => wordPattern(name)?.test(words))) found.add(project.id);
  }
  return found;
}

const known = (lookup: LensLookup, id: string | undefined | null): id is string =>
  !!id && lookup.projects.some((project) => project.id === id);

/** The projects one block is about. */
export function blockProjects(block: Block, lookup: LensLookup): Set<string> {
  const found = new Set<string>();
  const add = (id: string | undefined | null) => {
    if (known(lookup, id)) found.add(id);
  };
  if (block.lensProject) add(block.lensProject);
  if (block.catchUp) {
    for (const row of [...block.catchUp.finished, ...block.catchUp.decided, ...block.catchUp.needs]) add(row.projectId);
    return found;
  }
  if (block.needsRollup) {
    for (const item of block.needsRollup.items) add(item.projectId ?? lookup.needProject?.(item.key));
    return found;
  }
  if (block.besideMessage) {
    add(lookup.chatProject?.(block.besideMessage.chatId));
    if (!found.size) for (const id of textProjects(block.besideMessage.to, lookup)) found.add(id);
    return found;
  }
  if (block.role === "user" || block.role === "assistant") for (const id of textProjects(block.text, lookup)) found.add(id);
  return found;
}

/** The projects a turn (his message and the reply, or one app card) is about. Empty: it shows only under Everything. */
export function turnProjects(turn: readonly Block[], lookup: LensLookup): string[] {
  const found = new Set<string>();
  for (const block of turn) for (const id of blockProjects(block, lookup)) found.add(id);
  return [...found];
}

/** What the Chief of Staff reads beside a message he sent while the chat was narrowed to one project. */
export function lensNote(project: Pick<LensProject, "name">): string {
  return [
    "<narrowed_to_project>",
    `Ash is looking at only ${project.name} in this chat, so this message is about ${project.name} unless he says otherwise. Answer about ${project.name}, and pass work on to its first mate as usual. Name ${project.name} in your reply so it stays under this filter.`,
    "</narrowed_to_project>",
  ].join("\n");
}

/** The id a turn tag uses for a project: spaces can't go in a `~=` list. */
export function lensTag(projectId: string): string {
  return projectId.replace(/\s+/g, "_");
}

/** A folder inside (or equal to) another, compared the way project folders are keyed. */
function within(path: string, folder: string, key: (path: string) => string): boolean {
  const inner = key(path);
  const outer = key(folder);
  return !!outer && (inner === outer || inner.startsWith(`${outer}/`));
}

/**
 * What the filter reads, from the app's records: each project with its first mates' names, which project an open
 * Needs you item and a chat belong to.
 */
export function lensLookupFrom(input: {
  projects: readonly { id: string; name: string; folder?: string | null }[];
  monos: readonly { name?: string; projects?: readonly string[]; captain?: boolean; everyProject?: boolean; sessionId?: string; projectSessions?: Record<string, string> }[];
  needs: readonly { key: string; projectId?: string }[];
  chatFolder: (chatId: string) => string | undefined;
  key: (path: string) => string;
}): LensLookup {
  const projects: LensProject[] = input.projects.map((project) => ({
    id: project.id,
    name: project.name,
    folder: project.folder ?? null,
    mates: input.monos
      .filter((mono) => !mono.captain && !mono.everyProject && !!mono.name?.trim() && !!project.folder && (mono.projects ?? []).some((folder) => input.key(folder) === input.key(project.folder!)))
      .map((mono) => mono.name!.trim()),
  }));
  const byFolder = (folder: string | undefined) =>
    folder ? projects.find((project) => !!project.folder && within(folder, project.folder, input.key))?.id : undefined;
  return {
    projects,
    needProject: (key) => input.needs.find((item) => item.key === key)?.projectId,
    chatProject: (chatId) => {
      const found = byFolder(input.chatFolder(chatId));
      if (found) return found;
      for (const mono of input.monos) {
        for (const [folder, session] of Object.entries(mono.projectSessions ?? {})) if (session === chatId) return byFolder(folder);
        if (mono.sessionId === chatId && !mono.captain && (mono.projects ?? []).length === 1) return byFolder(mono.projects![0]);
      }
      return undefined;
    },
  };
}
