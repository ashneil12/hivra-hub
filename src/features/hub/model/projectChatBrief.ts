// G3 (Dropwave wiring): a Mono's own chat for one project (the Chief of Staff has one in every project, monoWorkspace.ts
// ensureMonoProjectSession) opens every turn on that project's brief, read live like the Mono list (liveMonos.ts): its
// name, its one line, its folder, its first mates and its open Needs you items. A Lead knows its project from its soul
// and its project memory; this chat is the same Mono as on Home, so the project it is in comes with each turn instead.
// The Mono's chat on Home has no project of its own and gets none: it keeps the every-project view.
//
// Short and bounded (a project with many needs lists the first few and counts the rest), one line per item, and every
// line goes through the export's secret patterns (portable/model/secrets.ts) before it reaches the model.
import { listMonos, monoLook, monoSessionProject, monoWorksOn, type Mono } from "../../monos/model/mono";
import { redactText } from "../../portable/model/secrets";
import { currentNeedsYou } from "../../needs/model/needsLive";
import type { NeedsItem } from "../../needs/model/needsYou";
import { hubData, hubMonoRank } from "./hubData";
import { retiredMonoIds } from "./hubConnectors";
import type { HubProject } from "./types";

/** At most this many open needs are listed; the rest are counted. */
export const BRIEF_MAX_NEEDS = 5;
/** At most this many first mates are named; the rest are counted. */
export const BRIEF_MAX_MATES = 8;
/** Every line is cut to this many characters. */
export const BRIEF_LINE_MAX = 160;

/** The hub's read-only checker (hubMcp.CHECKER_MONO_ID): not a first mate on any project. */
const CHECKER_ID = "checker";

/** One line: no line breaks, no secret, cut to the bound. */
function line(text: string, max = BRIEF_LINE_MAX): string {
  const flat = redactText(text).text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export type ProjectBriefInput = {
  project: Pick<HubProject, "id" | "name" | "folder" | "oneLine">;
  mates: readonly { name: string; role?: string }[];
  needs: readonly Pick<NeedsItem, "who" | "sentence">[];
};

/** The brief itself, from what was read for this turn. */
export function projectBriefNote({ project, mates, needs }: ProjectBriefInput): string {
  const name = line(project.name, 80);
  const lines = [`This chat is your chat for one project, ${name} (\`${line(project.id, 60)}\`), read live for this turn.`];
  const one = project.oneLine?.trim() ? line(project.oneLine) : "";
  if (one) lines.push(`What it is: ${one}`);
  lines.push(project.folder?.trim() ? `Its folder: ${line(project.folder, 240)}` : "It has no code folder.");
  if (mates.length) {
    const named = mates.slice(0, BRIEF_MAX_MATES).map((mate) => line(mate.role ? `${mate.name} (${mate.role})` : mate.name, 80));
    const more = mates.length - named.length;
    lines.push(`Its first mates: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`);
  } else lines.push("No first mate works on it yet.");
  if (needs.length) {
    const shown = needs.slice(0, BRIEF_MAX_NEEDS);
    lines.push(`Open in Ash's Needs you for it (${needs.length}):`);
    for (const need of shown) lines.push(`- ${line(`${need.who}: ${need.sentence}`)}`);
    if (needs.length > shown.length) lines.push(`- and ${needs.length - shown.length} more in the Inbox.`);
  } else lines.push("Nothing for it is waiting on Ash.");
  lines.push(`Answer about ${name} unless Ash names another project. This brief is the app's, not Ash's words: never quote it.`);
  return `<project_brief>\n${lines.join("\n")}\n</project_brief>`;
}

export type ProjectBriefReaders = {
  projects?: () => readonly HubProject[];
  monos?: () => readonly Mono[];
  needs?: () => readonly NeedsItem[];
};

/**
 * The brief for this turn when the chat is a Mono's own chat for one project; undefined for any other chat (its chat on
 * Home, a room's, a side chat) or a project that is no longer on the hub. A store that throws reads as empty.
 */
export function projectChatBrief(sessionId: string, readers: ProjectBriefReaders = {}): string | undefined {
  const projectId = monoSessionProject(sessionId);
  if (!projectId) return undefined;
  const project = (readers.projects ?? (() => hubData().listProjects()))().find((item) => item.id === projectId);
  if (!project) return undefined;
  const all = readers.monos ? readers.monos() : listMonos();
  const own = all.find((mono) => mono.projectSessions?.[projectId] === sessionId)?.id;
  // The same Monos the project's sidebar lists under First mates (MonoRailSection railMonos): given this project's folder.
  const key = project.folder?.trim() || `hub-project:${project.id}`;
  let retired: Set<string>;
  try {
    retired = new Set(retiredMonoIds());
  } catch {
    retired = new Set();
  }
  const mates = all
    .filter((mono) => mono.id !== own && mono.id !== CHECKER_ID && !retired.has(mono.id))
    .filter((mono) => mono.projects.includes(key) || (!!project.folder?.trim() && monoWorksOn(mono, key)))
    .map((mono, index) => ({ mono, index, rank: hubMonoRank(mono) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ mono }) => {
      const look = monoLook(mono);
      return { name: look.name, ...(look.role ? { role: look.role } : {}) };
    });
  let needs: readonly NeedsItem[];
  try {
    needs = (readers.needs ?? currentNeedsYou)().filter((item) => item.projectId === projectId);
  } catch {
    needs = [];
  }
  return projectBriefNote({ project, mates, needs });
}
