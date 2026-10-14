// Default dashboard templates per project type. A template defines a
// project's Today card set and its sidebar sections. Each project has one;
// a new project picks one. Mock store (localStorage); export/restore is file-based.
import { useSyncExternalStore } from "react";
import type { ProjectIconShape, ProjectItem } from "./types";

export type TemplateId = "game-studio" | "product-saas" | "org-ops";

export type DashboardTemplate = {
  id: TemplateId;
  label: string;
  blurb: string;
  icon: ProjectIconShape;
  /** Cards on the project's Today, top to bottom. */
  todayCards: string[];
  /** Project sections in the sidebar (between the teams and Being built). */
  sections: ProjectItem[];
};

export const TEMPLATES: DashboardTemplate[] = [
  {
    id: "game-studio", label: "Game studio", icon: "ghost",
    blurb: "Builds to play, playtest notes and what the team is building.",
    todayCards: ["Since you were last here", "Stuck and gave up", "Needs (up to 5)", "Latest build to try"],
    sections: [{ id: "builds", kind: "section", title: "Builds & playtests", sectionType: "builds-playtests" }],
  },
  {
    id: "product-saas", label: "Product / SaaS", icon: "sparkles",
    blurb: "Users, sign-ups and emails next to the work on the product.",
    todayCards: ["Since you were last here", "Stuck and gave up", "Needs (up to 5)", "Sign-ups this week"],
    sections: [{ id: "users", kind: "section", title: "Users & emails", sectionType: "users-emails" }],
  },
  {
    id: "org-ops", label: "Org / ops", icon: "gauge",
    blurb: "Decisions, people and the running of the company.",
    todayCards: ["Since you were last here", "Stuck and gave up", "Decisions (up to 5)"],
    sections: [],
  },
];

const DEFAULTS: Record<string, TemplateId> = {
  "exo-game": "game-studio",
  hivra: "product-saas",
  nibbii: "product-saas",
  "operator-os": "org-ops",
};

const KEY = "monocode:hub-templates";
const EVENT = "monocode:hub-templates-changed";

type Saved = Record<string, { template: TemplateId; customised?: boolean }>;

function load(): Saved {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null) ?? {};
  } catch {
    return {};
  }
}
let saved: Saved = load();
let version = 0;
function store(next: Saved): void {
  saved = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* best effort */
  }
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useTemplatesVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
}

export function templateOf(projectId: string): DashboardTemplate {
  const id = saved[projectId]?.template ?? DEFAULTS[projectId] ?? "org-ops";
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[2];
}

/** True when the project's dashboard was changed from its template (e.g. an applied proposal). */
export function isCustomised(projectId: string): boolean {
  return saved[projectId]?.customised ?? CUSTOMISED_EXAMPLE.has(projectId);
}
/** Example: Hivra's dashboard was changed by an applied proposal ('Users & emails'). */
const CUSTOMISED_EXAMPLE = new Set(["hivra"]);

export function setTemplate(projectId: string, template: TemplateId): void {
  store({ ...saved, [projectId]: { template } });
}

/** Back to the template's default cards and sections. */
export function resetToTemplate(projectId: string): void {
  store({ ...saved, [projectId]: { template: templateOf(projectId).id, customised: false } });
  resetDone.add(projectId);
}
const resetDone = new Set<string>();
export function wasReset(projectId: string): boolean {
  return resetDone.has(projectId);
}

/** Whole setup as one file (Glance-style: one settings block per project). */
export function exportSetup(projectIds: string[]): string {
  const projects = Object.fromEntries(projectIds.map((id) => [id, { template: templateOf(id).id }]));
  return JSON.stringify({ format: "monocode-hub-setup", version: 1, projects }, null, 2);
}

/** Restore from an exported file. Returns how many projects it set. */
export function restoreSetup(text: string): number {
  const data = JSON.parse(text) as { format?: string; projects?: Record<string, { template: TemplateId }> };
  if (data.format !== "monocode-hub-setup" || !data.projects) throw new Error("That file isn't a Monocode setup export.");
  const next: Saved = { ...saved };
  for (const [id, p] of Object.entries(data.projects)) {
    if (TEMPLATES.some((t) => t.id === p.template)) next[id] = { template: p.template };
  }
  store(next);
  return Object.keys(data.projects).length;
}
