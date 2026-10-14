// Example data until Claude Code wires the backend. Everything here is
// placeholder content and is labelled "Example" where Ash would see it.
import type { HubDataSource, HubMono, HubProject, Need, ProjectItem, StuckItem } from "./types";

const PROJECTS: HubProject[] = [
  { id: "exo-game", name: "EXO game", shortName: "EXO", iconShape: "ghost", folder: "/Users/ash/harness/exo-game" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/ash/harness/hivra" },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "palette", folder: "/Users/ash/harness/nibbii" },
  { id: "operator-os", name: "Operator OS", shortName: "Operator", iconShape: "gauge", folder: "/Users/ash/harness/org" },
];

const SECTIONS: Record<string, ProjectItem[]> = {
  "exo-game": [{ id: "builds", kind: "section", title: "Builds & playtests", sectionType: "builds-playtests" }],
  hivra: [{ id: "users", kind: "section", title: "Users & emails", sectionType: "users-emails" }],
};

const NEEDS: Need[] = [
  { id: "n1", projectId: "exo-game", title: "Example: play Areas 1 and 2", why: "The new level changed how these play. It needs your hands on it.", actionType: "start", actionLabel: "Start playtest" },
  { id: "n2", projectId: "exo-game", title: "Example: skim the new game rules", why: "Four rules written down. Check they match what you meant.", actionType: "open", actionLabel: "Open" },
  { id: "n3", projectId: "hivra", title: "Example: pick the waitlist headline", why: "Two versions tested about the same. Your taste call.", actionType: "open", actionLabel: "Open" },
];

const STUCK: StuckItem[] = [
  { id: "s1", projectId: "hivra", title: "Example: nightly backup failing", detail: "Retried 3 times since 2am. No one picked it up.", state: "stuck" },
];

const SINCE: Record<string, string> = {
  "exo-game": "Example: the new level is in and working. Two things need your hands.",
  hivra: "Example: the nightly backup is stuck and hasn't been sent to anyone.",
};

const MONOS: HubMono[] = [
  { id: "mono-invader", name: "MonoInvader", mascot: "invader", color: "teal", status: "working", projectIds: ["exo-game"] },
  { id: "playtester", name: "Playtester", mascot: "ghost", color: "violet", status: "idle", projectIds: ["exo-game"] },
  { id: "hivra-mailer", name: "Hivra mailer", mascot: "cat", color: "amber", status: "idle", projectIds: ["hivra"] },
];

export const mockHubData: HubDataSource = {
  listProjects: () => PROJECTS,
  listProjectItems: (projectId) => [
    { id: "coding-team", kind: "coding-team", title: "Coding team" },
    { id: "leadership-team", kind: "leadership-team", title: "Leadership team" },
    ...(SECTIONS[projectId] ?? []),
    { id: "being-built", kind: "being-built", title: "Being built" },
  ],
  // Example: Ash was last here at 2pm today.
  lastActiveAt: () => {
    const d = new Date();
    d.setHours(14, 0, 0, 0);
    return d.toISOString();
  },
  sinceSummary: (projectId) => ({
    plainText: projectId
      ? (SINCE[projectId] ?? "Example: quiet since you were last here.")
      : "Example: the game's new level is in and working. In Hivra, the nightly backup is stuck and hasn't been sent to anyone. Nibbii and Operator OS were quiet.",
    details: "Example details.",
  }),
  listNeeds: (projectId) => NEEDS.filter((n) => !projectId || n.projectId === projectId),
  listStuck: (projectId) => STUCK.filter((s) => !projectId || s.projectId === projectId),
  listMonos: (projectId) => MONOS.filter((m) => !projectId || m.projectIds.includes(projectId)),
};
