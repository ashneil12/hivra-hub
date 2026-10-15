import { examples, examplesOn } from "./examples";
import { templateOf } from "./templates";
// Example data until Claude Code wires the backend. Everything here is
// placeholder content and is labelled "Example" where Ash would see it.
import { listChats } from "./hubChats";
import type { HubDataSource, HubMono, HubProject, Need, ProjectItem, StuckItem } from "./types";

const EXAMPLE_PROJECTS: HubProject[] = [
  { id: "exo-game", name: "EXO game", shortName: "EXO", iconShape: "ghost", folder: "/Users/ash/harness/exo-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/ash/harness/hivra" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "palette", folder: "/Users/ash/harness/nibbii" },
  { id: "harness", name: "Harness", shortName: "Harness", iconShape: "gauge", folder: "/Users/ash/harness/org" },
];


const NEEDS: Need[] = examples([
  { id: "o1", projectId: "harness", title: "Example: approve the Q4 hiring plan", why: "Two roles changed since last week.", actionType: "open", actionLabel: "Open" },
  { id: "o2", projectId: "harness", title: "Example: sign the vendor renewal", why: "Due Friday; price is unchanged.", actionType: "open", actionLabel: "Open" },
  { id: "o3", projectId: "harness", title: "Example: review the on-call rota", why: "Next month has a gap on the 12th.", actionType: "open", actionLabel: "Open" },
  { id: "o4", projectId: "harness", title: "Example: pick the offsite dates", why: "Three options; everyone else has voted.", actionType: "open", actionLabel: "Open" },
  { id: "o5", projectId: "harness", title: "Example: check the budget summary", why: "Spend is 4% under plan.", actionType: "open", actionLabel: "Open" },
  { id: "n1", projectId: "exo-game", title: "Example: play Areas 1 and 2", why: "The new level changed how these play. It needs your hands on it.", actionType: "start", actionLabel: "Start playtest" },
  { id: "n2", projectId: "exo-game", title: "Example: skim the new game rules", why: "Four rules written down. Check they match what you meant.", actionType: "open", actionLabel: "Open" },
  { id: "n3", projectId: "hivra", title: "Example: pick the waitlist headline", why: "Two versions tested about the same. Your taste call.", actionType: "open", actionLabel: "Open" },
]);

const STUCK: StuckItem[] = examples([
  { id: "s1", projectId: "hivra", title: "Example: nightly backup failing", detail: "Retried 3 times since 2am. No one picked it up.", state: "stuck" },
  { id: "s2", projectId: "hivra", title: "Example: email sender broken", detail: "The lead tried two fixes and gave up. It needs a person.", state: "lead_gave_up" },
]);

const SINCE: Record<string, string> = {
  "exo-game": "Example: the new level is in and working. Two things need your hands.",
  hivra: "Example: the nightly backup is stuck and hasn't been sent to anyone.",
};

const MONOS: HubMono[] = [
  { id: "mono-invader", name: "Lead", mascot: "robot", color: "teal", status: "working", projectIds: ["exo-game"] },
  { id: "playtester", name: "Playtester", mascot: "ghost", color: "violet", status: "idle", projectIds: ["exo-game"] },
  { id: "hivra-mailer", name: "Hivra mailer", mascot: "cat", color: "amber", status: "idle", projectIds: ["hivra"] },
];

/**
 * The app ships clean: no projects. Our example projects show only behind the
 * dev flag (`monocode:hub-examples`, set by the dev page). Projects Ash makes or
 * restores from a setup file are kept locally.
 */
const USER_KEY = "monocode:hub-projects";
function loadUserProjects(): HubProject[] {
  try {
    return (JSON.parse(localStorage.getItem(USER_KEY) ?? "null") as HubProject[] | null) ?? [];
  } catch {
    return [];
  }
}
const USER_PROJECTS: HubProject[] = loadUserProjects();
const PROJECTS: HubProject[] = [...(examplesOn() ? EXAMPLE_PROJECTS : []), ...USER_PROJECTS];

/** Projects made here or restored from a setup file (kept locally). The live source adds them to Ash OS's list. */
export function userProjects(): HubProject[] {
  return USER_PROJECTS;
}

/** What a project lists in the sidebar: its teams, chats, template sections and Being built. No folder, no Coding team. */
export function projectItems(projectId: string, hasFolder = true): ProjectItem[] {
  return [
    ...(hasFolder ? [{ id: "coding-team", kind: "coding-team" as const, title: "Coding team" }] : []),
    { id: "leadership-team", kind: "leadership-team", title: "Leadership team" },
    ...listChats(projectId)
      .filter((c) => !c.isDefault)
      .map((c): ProjectItem => ({ id: `chat:${c.id}`, kind: "group-chat", title: c.name })),
    // Template sections (Builds & playtests, Users & emails) have no backend yet: their screens are example data or a
    // "built in Unit N" placeholder, so a normal build doesn't list them. They come back when they are wired.
    ...(examplesOn() ? templateOf(projectId).sections : []),
    { id: "being-built", kind: "being-built", title: "Being built" },
  ];
}

export const mockHubData: HubDataSource = {
  listProjects: () => PROJECTS,
  listProjectItems: (projectId) => projectItems(projectId),
  // Example: Ash was last here at 2pm today.
  lastActiveAt: () => {
    const d = new Date();
    d.setHours(14, 0, 0, 0);
    return d.toISOString();
  },
  sinceAt: () => mockHubData.lastActiveAt(),
  sinceSummary: (projectId) => ({
    plainText: !examplesOn()
      ? "Nothing new yet. As your teams start work, what changed shows up here."
      : projectId
      ? (SINCE[projectId] ?? "Example: quiet since you were last here.")
      : "Example: the game's new level is in and working. In Hivra, the nightly backup is stuck and hasn't been sent to anyone. Harness has five decisions for you. Nibbii was quiet.",
    details: "Example details.",
  }),
  listNeeds: (projectId) => NEEDS.filter((n) => !projectId || n.projectId === projectId),
  listStuck: (projectId) => STUCK.filter((s) => !projectId || s.projectId === projectId),
  listMonos: (projectId) => MONOS.filter((m) => !projectId || m.projectIds.includes(projectId)),
  listSetup: () => [],
  listOlder: () => [],
  connection: () => ({ status: "ready" }),
  retry: () => undefined,
};

/** Mock: create a project from the new-project flow. */
export function addMockProject(p: HubProject): void {
  if (PROJECTS.some((x) => x.id === p.id)) return;
  PROJECTS.push(p);
  if (EXAMPLE_PROJECTS.some((x) => x.id === p.id)) return;
  USER_PROJECTS.push(p);
  try {
    localStorage.setItem(USER_KEY, JSON.stringify([...loadUserProjects().filter((x) => x.id !== p.id), p]));
  } catch {
    /* best effort */
  }
}
