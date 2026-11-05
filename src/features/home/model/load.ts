// One read of Home. A later read wins. A timeout throws, so the caller keeps the last good screen and tries again.

import { invoke } from "@tauri-apps/api/core";
import { currentViewId } from "../../creator/model/view";
import { tauriFirstMate } from "../../firstmate/model/steering";
import { hubData } from "../../hub/model/hubData";
import type { LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import { readCatalog, type CatalogPanel } from "../../panels/model/panelTabs";
import type { HomeArrangement } from "./arrangement";
import {
  type HomeChat,
  type HomeDecision,
  type HomeDoc,
  type HomeProject,
  type HomeTask,
  namesFor,
  needsYouLines,
  parseDecision,
  parseDoc,
  parseTask,
  sanitizeProjects,
  taskReadKeys,
} from "./lines";
import { browserStorage, readHome, type HomeStorage } from "./store";

export class LateHomeLoad extends Error {
  constructor() {
    super("late");
    this.name = "LateHomeLoad";
  }
}

export type HomeSnapshot = {
  projects: HomeProject[];
  decisions: HomeDecision[];
  tasks: HomeTask[];
  docs: HomeDoc[];
  chats: HomeChat[];
  catalog: CatalogPanel[];
  arrangement: HomeArrangement;
  rev: number;
};

export type HomeSource = {
  decisions(): Promise<unknown>;
  tasks(project: string): Promise<unknown>;
  docs(): Promise<unknown>;
  projects(): unknown;
  catalog(): Promise<unknown>;
  disk: LocalHubDisk;
  storage: HomeStorage;
};

function listOf(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function dedupeTasks(tasks: HomeTask[]): HomeTask[] {
  const out: HomeTask[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

export async function fetchHome(source: HomeSource, now: () => number = Date.now): Promise<HomeSnapshot> {
  const projects = sanitizeProjects(source.projects());
  const keys = taskReadKeys(projects);
  const [decisionsRaw, docsRaw, catalogRaw, home, ...taskLists] = await Promise.all([
    source.decisions(),
    source.docs(),
    source.catalog(),
    readHome(source.disk, source.storage, now),
    ...keys.map((key) => source.tasks(key)),
  ]);
  return {
    projects,
    decisions: listOf(decisionsRaw).map(parseDecision).filter((item): item is HomeDecision => item != null),
    tasks: dedupeTasks(taskLists.flatMap((list) => listOf(list).map(parseTask).filter((item): item is HomeTask => item != null))),
    docs: listOf(docsRaw).map(parseDoc).filter((item): item is HomeDoc => item != null),
    chats: home.doc.recent,
    catalog: readCatalog(catalogRaw),
    arrangement: home.doc.arrangement,
    rev: home.rev,
  };
}

/** How many lines need the person. A throw is "not known yet", never zero. */
export async function loadNeedsYouCount(source: HomeSource): Promise<number> {
  const projects = sanitizeProjects(source.projects());
  const keys = taskReadKeys(projects);
  const [decisionsRaw, ...taskLists] = await Promise.all([
    source.decisions(),
    ...keys.map((key) => source.tasks(key)),
  ]);
  const decisions = listOf(decisionsRaw).map(parseDecision).filter((item): item is HomeDecision => item != null);
  const tasks = dedupeTasks(taskLists.flatMap((list) => listOf(list).map(parseTask).filter((item): item is HomeTask => item != null)));
  return needsYouLines(decisions, tasks, namesFor(projects)).length;
}

export function createHomeLoader(source: HomeSource, now: () => number = Date.now) {
  let generation = 0;
  return {
    invalidate() {
      generation += 1;
    },
    async load(): Promise<HomeSnapshot> {
      const gen = ++generation;
      const snapshot = await fetchHome(source, now);
      if (gen !== generation) throw new LateHomeLoad();
      return snapshot;
    },
  };
}

export function realHomeSource(): HomeSource {
  return {
    decisions: () => tauriFirstMate.decisions(0),
    tasks: (project) => invoke("tasks_list", { actor: { id: "person", project, kind: "person" } }),
    docs: () => invoke("docs_list"),
    projects: () => hubData().listProjects().map((project) => ({ id: project.id, name: project.name, folder: project.folder ?? null })),
    catalog: () => invoke("panels_catalog", { view: currentViewId() }),
    disk: tauriLocalHubDisk,
    storage: browserStorage(),
  };
}
