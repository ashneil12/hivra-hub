// Hub data shapes. They follow the spec's "Handoff notes for Claude Code"
// (SPEC.md, H1b). The frontend only talks to `HubDataSource`; Claude Code
// replaces the mock source with the real backend.

/** Grey icon shape that tells a project apart. Never a colour. */
export type ProjectIconShape = "ghost" | "sparkles" | "palette" | "gauge" | "folder";

export type HubProject = {
  id: string;
  name: string;
  /** Short name under the strip icon (at least 11px, 60% bright). */
  shortName: string;
  iconShape: ProjectIconShape;
  /** Folder the Coding team workspace opens. */
  folder: string;
};

/** Everything a project has, listed where Monocode's sidebar lists Projects. */
export type ProjectItemKind =
  | "coding-team"
  | "leadership-team"
  | "group-chat"
  | "section"
  | "being-built";

export type ProjectItem = {
  id: string;
  kind: ProjectItemKind;
  title: string;
  /** For sections: the module type, e.g. "builds-playtests". */
  sectionType?: string;
};

export type NeedActionType = "start" | "open" | "sign_in" | "see_options";

export type Need = {
  id: string;
  projectId: string;
  title: string;
  why: string;
  actionType: NeedActionType;
  actionLabel: string;
  actionTarget?: string;
  later?: boolean;
};

export type StuckState = "stuck" | "sent_to_lead" | "lead_gave_up";

export type StuckItem = {
  id: string;
  projectId: string;
  title: string;
  detail: string;
  state: StuckState;
  sentAt?: string;
};

export type SinceSummary = { plainText: string; details: string };

export type HubMono = {
  id: string;
  name: string;
  mascot: string;
  color: string;
  status: "idle" | "working";
  projectIds: string[];
};

export interface HubDataSource {
  listProjects(): HubProject[];
  listProjectItems(projectId: string): ProjectItem[];
  /** Open Needs plus stuck items needing Ash, per project. No zero badges. */
  needCount(projectId: string): number;
  lastActiveAt(): string;
  sinceSummary(projectId?: string): SinceSummary;
  listNeeds(projectId?: string): Need[];
  listStuck(projectId?: string): StuckItem[];
  listMonos(projectId?: string): HubMono[];
}
