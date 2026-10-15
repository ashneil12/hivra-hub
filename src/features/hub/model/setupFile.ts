// Export / restore the whole setup as a file. The app ships clean; Ash's own
// setup arrives through one of these files. Nothing is added until Restore.
import { addMockProject } from "./mockData";
import { hubData } from "./hubData";
import { setTemplate, templateOf, TEMPLATES, type TemplateId } from "./templates";
import { addConnectors, allConnectors } from "./connectors";
import { allKeptPages, importPages, type Page } from "../../pages/model/pages";
import { addMember, ensureLeadership, getChat, leadershipChatId } from "./hubChats";
import type { HubProject } from "./types";

export type SetupBot = {
  id: string;
  name: string;
  /** One line on what it does. */
  role: string;
  projectId: string;
  team: "leadership" | "coding";
  skills: number;
  mascot: string;
};
export type SetupConnector = { id: string; name: string; projectId: string };

export type SetupFile = {
  format: "monocode-hub-setup";
  version: 1;
  projects: (HubProject & { template: TemplateId })[];
  bots?: SetupBot[];
  /** Which services the bots use. Never carries passwords or keys. */
  connectors?: SetupConnector[];
  /** Kept Pages. They come back with no permissions; Ash allows their asks again. */
  pages?: Page[];
};

type RosterEntry = { id: string; name?: string; mascot?: string; projects?: string[] };
function exportBots(projects: SetupFile["projects"]): SetupBot[] {
  let roster: RosterEntry[] = [];
  try {
    roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as RosterEntry[];
  } catch {
    /* no roster */
  }
  const bots: SetupBot[] = [];
  for (const m of roster) {
    for (const p of projects.filter((x) => (m.projects ?? []).includes(x.folder ?? ""))) {
      const lead = getChat(leadershipChatId(p.id))?.memberIds.includes(m.id) ?? false;
      bots.push({ id: m.id, name: m.name ?? m.id, role: "", projectId: p.id, team: lead ? "leadership" : "coding", skills: 0, mascot: m.mascot ?? "robot" });
    }
  }
  return bots;
}

/** The whole setup: projects with their templates, Monos, which services they use, and kept Pages. No keys, ever. */
export function exportSetup(): string {
  const projects = hubData().listProjects().map((p) => ({ ...p, template: templateOf(p.id).id }));
  const file: SetupFile = {
    format: "monocode-hub-setup",
    version: 1,
    projects,
    bots: exportBots(projects),
    // Which services, never the account or anything signed in.
    connectors: allConnectors().map(({ id, name, projectId }) => ({ id, name, projectId })),
    pages: allKeptPages().map((p) => ({ ...p, permissions: [] })),
  };
  return JSON.stringify(file, null, 2);
}

export function parseSetup(text: string): SetupFile {
  const data = JSON.parse(text) as Partial<SetupFile>;
  if (data.format !== "monocode-hub-setup" || !Array.isArray(data.projects)) throw new Error("That file isn't a Monocode setup export.");
  return { format: "monocode-hub-setup", version: 1, projects: data.projects, bots: data.bots ?? [], connectors: data.connectors ?? [], pages: Array.isArray(data.pages) ? data.pages : [] };
}

/** Adds the projects, the ticked bots and the connectors (as sign-in Needs). */
export function applySetup(file: SetupFile, botIds?: ReadonlySet<string>): number {
  for (const p of file.projects) {
    const { template, ...project } = p;
    addMockProject(project);
    if (TEMPLATES.some((t) => t.id === template)) setTemplate(project.id, template);
  }
  const bots = (file.bots ?? []).filter((b) => !botIds || botIds.has(b.id));
  if (bots.length) {
    const folder = (pid: string) => file.projects.find((p) => p.id === pid)?.folder ?? "";
    try {
      const roster = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as { id: string }[];
      const have = new Set(roster.map((m) => m.id));
      const added = bots.filter((b) => !have.has(b.id)).map((b) => ({
        id: b.id, name: b.name, mascot: b.mascot, color: "hsl(210 8% 58%)", projects: [folder(b.projectId)],
      }));
      localStorage.setItem("monocode:mono-roster", JSON.stringify([...roster, ...added]));
    } catch {
      /* best effort */
    }
    for (const b of bots.filter((x) => x.team === "leadership")) {
      ensureLeadership(b.projectId);
      addMember(leadershipChatId(b.projectId), b.id);
    }
  }
  addConnectors(file.connectors ?? []);
  importPages(file.pages ?? []);
  return file.projects.length;
}

/** Older callers: restore everything in the file at once. */
export function restoreSetup(text: string): number {
  return applySetup(parseSetup(text));
}

// The file picked for the Restore preview, until Ash presses Restore or Back.
let pending: { file: SetupFile; name: string } | null = null;
export function setPendingSetup(file: SetupFile, name: string): void {
  pending = { file, name };
}
export function pendingSetup(): { file: SetupFile; name: string } | null {
  return pending;
}
export function clearPendingSetup(): void {
  pending = null;
}

export function downloadSetup(): void {
  const blob = new Blob([exportSetup()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "monocode-setup.json";
  a.click();
  URL.revokeObjectURL(a.href);
}
