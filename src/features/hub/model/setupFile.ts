// Export / restore the whole setup as a file. The app ships clean; Ash's own
// setup arrives through one of these files. Nothing is added until Restore.
import { addMockProject } from "./mockData";
import { hubData } from "./hubData";
import { setTemplate, templateOf, TEMPLATES, type TemplateId } from "./templates";
import { addConnectors, allConnectors } from "./connectors";
import { allKeptPages, importPages, type Page } from "../../pages/model/pages";
import { ensureLeadership, getChat, leadershipChatId, exportChats, importChats, validGroupChats } from "./hubChats";
import type { GroupChat, HubProject } from "./types";
import { collectSouls, importSouls, type SetupSoul } from "./setupSouls";

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
  chats?: GroupChat[];
  /** Which services the bots use. Never carries passwords or keys. */
  connectors?: SetupConnector[];
  /** Kept Pages. They come back with no permissions; Ash allows their asks again. */
  pages?: Page[];
  /** Each Mono's soul: role, rules, memory, workflows and skills. Monos that aren't seated wait for Ash's OK. */
  souls?: SetupSoul[];
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
    chats: exportChats(),
    // Which services, never the account or anything signed in.
    connectors: allConnectors().map(({ id, name, projectId }) => ({ id, name, projectId })),
    pages: allKeptPages().map((p) => ({ ...p, permissions: [] })),
  };
  return JSON.stringify(file, null, 2);
}

export function parseSetup(text: string): SetupFile {
  const data = JSON.parse(text) as Partial<SetupFile>;
  if (data.format !== "monocode-hub-setup" || !Array.isArray(data.projects)) throw new Error("That file isn't a Monocode setup export.");
  return { format: "monocode-hub-setup", version: 1, projects: data.projects, bots: data.bots ?? [], connectors: data.connectors ?? [], pages: Array.isArray(data.pages) ? data.pages : [], souls: Array.isArray(data.souls) ? data.souls : [], chats: validGroupChats(data.chats) };
}

/** Adds the projects, the ticked bots and the connectors (as sign-in Needs). */
export function applySetup(file: SetupFile, botIds?: ReadonlySet<string>): number {
  for (const p of file.projects) {
    const { template, ...project } = p;
    addMockProject(project);
    if (TEMPLATES.some((t) => t.id === template)) setTemplate(project.id, template);
  }
  // Monos are never seated by a file: each one that isn't seated waits for Ash's OK, with its soul if the file has one.
  const bots = (file.bots ?? []).filter((b) => !botIds || botIds.has(b.id));
  const souls = file.souls ?? [];
  const soulFor = new Map(souls.map((x) => [x.monoId, x]));
  importSouls([
    // Unticked bots stay out; souls with no bot row always come in (as waiting).
    ...souls.filter((x) => !botIds || botIds.has(x.monoId) || !(file.bots ?? []).some((b) => b.id === x.monoId)),
    ...bots.filter((b) => !soulFor.has(b.id)).map((b) => ({ monoId: b.id, name: b.name, role: b.role, rules: "", memory: "", workflows: "", skills: [], mascot: b.mascot })),
  ]);
  importChats(validGroupChats(file.chats).map((c) => ({ ...c, memberIds: c.memberIds.filter((id) => !botIds || botIds.has(id)) })));
  for (const b of bots.filter((x) => x.team === "leadership")) ensureLeadership(b.projectId);
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

/** The file with every Mono's soul read in. */
export async function exportSetupWithSouls(read?: Parameters<typeof collectSouls>[0]): Promise<string> {
  const file = JSON.parse(exportSetup()) as SetupFile;
  file.souls = await collectSouls(read);
  return JSON.stringify(file, null, 2);
}

export async function downloadSetup(): Promise<void> {
  const blob = new Blob([await exportSetupWithSouls()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "monocode-setup.json";
  a.click();
  URL.revokeObjectURL(a.href);
}
