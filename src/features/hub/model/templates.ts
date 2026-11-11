// Default dashboard templates per project type. A template defines a
// project's Today card set and its sidebar sections. Each project has one;
// a new project picks one. Mock store (localStorage); export/restore is file-based.
import { useSyncExternalStore } from "react";
import { currentTodayCards } from "./todayCards";
import { TODAY_DEFAULT, type ProjectIconShape, type ProjectItem, type TodaySection } from "./types";
export { currentTodayCards, LEGACY_TODAY_CARDS, NEEDS_YOU_CARD } from "./todayCards";

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
  /** Suggested Monos for a new project's teams. */
  leadership: string[];
  coding: string[];
};

export const TEMPLATES: DashboardTemplate[] = [
  {
    id: "game-studio", label: "Game studio", icon: "gamepad",
    blurb: "Builds to play, playtest notes and what the team is building.",
    todayCards: ["Since you were last here", "Needs you", "Latest build to try"],
    sections: [{ id: "builds", kind: "section", title: "Builds & playtests", sectionType: "builds-playtests" }],
    leadership: ["Chief of Staff", "Planner", "Record keeper", "Team steward"],
    coding: ["Builder", "Tester"],
  },
  {
    id: "product-saas", label: "Product / SaaS", icon: "sparkles",
    blurb: "Dashboards and reports next to the work on the product.",
    todayCards: ["Since you were last here", "Needs you", "Latest dashboard"],
    sections: [{ id: "dashboards", kind: "section", title: "Dashboards", sectionType: "project-pages" }],
    leadership: ["Chief of Staff", "Planner", "Record keeper", "Team steward"],
    coding: ["Builder", "Tester"],
  },
  {
    id: "org-ops", label: "Org / ops", icon: "gauge",
    blurb: "Decisions, people and the running of the company.",
    todayCards: ["Since you were last here", "Needs you"],
    sections: [],
    leadership: ["Chief of Staff", "Planner", "Record keeper", "Team steward"],
    coding: ["Builder"],
  },
];

const DEFAULTS: Record<string, TemplateId> = {
  "exo-game": "game-studio",
  // The game project as Ash OS names it.
  "vg-game": "game-studio",
  hivra: "product-saas",
  nibbii: "product-saas",
  harness: "org-ops",
  hub: "org-ops",
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

/**
 * The Today section each of a template's cards draws. Every card here reads live data: the since paragraph and Needs
 * you are the app's own, the latest build comes from Builds & playtests, the latest dashboard from the pages kept for
 * the project. A card Today can't draw draws nothing.
 */
const CARD_SECTIONS: Readonly<Record<string, TodaySection>> = {
  "Since you were last here": { id: "since", kind: "since", title: "Since you were last here" },
  "Needs you": { id: "needs", kind: "needs", title: "Needs you" },
  "Latest build to try": { id: "latest-build", kind: "latest-build", title: "Latest build to try" },
  "Latest dashboard": { id: "latest-dashboard", kind: "latest-page", title: "Latest dashboard" },
};

/** A template's card names as Today sections, in the template's order, each card once (old card names mapped). */
export function sectionsForCards(cards: readonly string[]): TodaySection[] {
  const out = currentTodayCards(cards).flatMap((card) => {
    const section = CARD_SECTIONS[card];
    return section ? [{ ...section }] : [];
  });
  // A dashboard naming only cards we don't know still opens on Today's usual sections rather than blank.
  return out.length ? out : TODAY_DEFAULT.filter((s) => s.kind !== "being-built").map((s) => ({ ...s }));
}

/** True when the project's dashboard was changed from its template (an applied proposal or Ash's own choice). */
export function isCustomised(projectId: string): boolean {
  return saved[projectId]?.customised ?? false;
}

/** True when this Mac has its own template choice for the project (an import then leaves it alone). */
export function hasSavedTemplate(projectId: string): boolean {
  return !!saved[projectId];
}

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

