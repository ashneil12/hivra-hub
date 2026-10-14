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
  lastActiveAt(): string;
  sinceSummary(projectId?: string): SinceSummary;
  listNeeds(projectId?: string): Need[];
  listStuck(projectId?: string): StuckItem[];
  listMonos(projectId?: string): HubMono[];
}

/** One message in a group chat. `from` is "ash" or a Mono id. */
export type ChatMessage = {
  id: string;
  from: "ash" | string;
  text: string;
  /** Only stuck or given-up items carry a status. */
  status?: StuckState;
  /** The Need or stuck item this message is about (same data as Today). */
  refId?: string;
};

export type ChatConversation = {
  id: string;
  /** "Today", "Yesterday", "12 Oct". */
  when: string;
  title: string;
  messages: ChatMessage[];
};

/** A project's group chat. The Leadership team is the default one. */
export type GroupChat = {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  memberIds: string[];
  conversations: ChatConversation[];
};

export type BuildStatus = "ready" | "building" | "failed";

export type PlaytestNote = { id: string; when: string; text: string };

/** One build to try (Builds & playtests section). */
export type Build = {
  id: string;
  projectId: string;
  version: string;
  /** One line: what changed. */
  title: string;
  status: BuildStatus;
  /** Plain reason when failed. */
  failReason?: string;
  /** Set only when a failed build is stuck or the lead gave up. */
  stuck?: StuckState;
  /** "play" runs the game; "open" opens a link or file. */
  action?: "play" | "open";
  builtAt: string;
  notes: PlaytestNote[];
  /** Only Ash can mark a build played; the data layer rejects anyone else. */
  played?: { by: "ash"; at: string };
};

export type ActivityStep = { id: string; at: string; text: string };

/** One active worker or Mono on a project (Being built). */
export type Worker = {
  id: string;
  projectId: string;
  /** Display name: a Mono's name or a plain worker name. */
  who: string;
  kind: "coding" | "mono" | "worker";
  /** What it's doing now, in plain words. */
  doing: string;
  /** Minutes at it so far. */
  minutes: number;
  stuck?: StuckState;
  steps: ActivityStep[];
  /** Id of the waiting item that already covers this worker being stuck. */
  waitingId?: string;
  /** Set when finished today. */
  finishedAt?: string;
};
