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
  /** Folder the Coding team workspace opens. Null for a project with no code folder (no Coding team). */
  folder: string | null;
  /** Shelved in Ash OS's registry. Not on the strip. */
  parked?: boolean;
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

export type NeedActionType = "start" | "open" | "sign_in" | "see_options" | "accept";

export type Need = {
  id: string;
  projectId: string;
  title: string;
  why: string;
  actionType: NeedActionType;
  actionLabel: string;
  actionTarget?: string;
  later?: boolean;
  /** "done" once it was answered or cleared anywhere: the row ticks itself off and stays until Ash leaves the page. */
  state?: "open" | "done";
  /** ISO time it appeared (from Ash OS). */
  since?: string;
  /** ISO time it ticked off, and why (answered, expired, ...). */
  doneAt?: string;
  doneReason?: string;
  detail?: string;
  /** A job the Lead gave up on: a red circle and "Needs you" (a 14px circle and a plain grey word, nothing else). */
  circle?: "amber" | "red";
  word?: string;
  /** Set for a Need that is a job's (target `job:<id>`): See options opens the job's sheet. */
  jobId?: string;
  /** A "Looks right" row: the one action is to mark it seen (`ash-hub-need-seen`). */
  canMarkSeen?: boolean;
};

/** A job as Ash OS reports it (Being built). Times are ISO. */
export type JobWireState =
  | "working" | "checking" | "stuck" | "sent_to_lead" | "lead_gave_up" | "done" | "parked";

export type HubJob = {
  id: string;
  projectId: string;
  title: string;
  /** The Mono running it (a Lead is "<Project> lead"); null while the project has no Lead. */
  lead: string | null;
  leadName: string | null;
  state: JobWireState;
  /** Why it is stuck, in plain words. */
  reason: string;
  startedAt: string;
  lastActiveAt: string;
  finishedAt: string | null;
  seen: boolean;
  circle?: "amber" | "red";
  word?: string;
  /** "Sent to coding team lead at 2:20pm" (stuck jobs sent to a Lead) and the Lead's "Got it". */
  sentText?: string;
  gotIt?: { at: string; text: string } | null;
  tried?: string[];
  why?: string;
  retryAt?: string;
  /** A part of a bigger job the Lead split up (its workers): the big job's id and title. Shown as one row. */
  parentId?: string;
  parentTitle?: string;
};

/** Jobs grouped under the Mono running them, in the order Ash OS lists them (it never re-sorts). */
export type HubJobGroup = { leadId: string | null; leadName: string; projectId: string; jobs: HubJob[] };

/** A question Ash is asked (`ash-hub-question`). Most have no options: then the recommendation and the quick answers. */
export type HubQuestion = {
  /** The Needs row id (`q:<question id>`), which both calls take. */
  id: string;
  questionId: string;
  status: "open" | "answered" | "expired";
  question: string;
  options: { label: string; detail?: string }[];
  recommendation: { text: string; optionIndex: number | null };
  /** `agree` (only with a recommendation), `drop`, `park`. */
  quickAnswers: { id: string; label: string }[];
  askedAt?: string;
  /** His answer is saved and waits for the model (it was down). */
  heldAnswer?: string;
};

/** Ash's answer: an option's index and/or his words, or one quick answer alone. */
export type HubAnswer = { choice?: number; text?: string; quick?: "agree" | "drop" | "park" };

/** An answer on its way or back: "Sending…" in the row, then the receipt; the row ticks off only if it closed. */
export type AnswerState = { sending: boolean; receipt?: string; problem?: string; closed?: boolean };

/** One choice on a given-up job's "See options" sheet. */
export type JobOption = { id: string; label: string; needsText: boolean; note: string; placeholder?: string };
export type JobOptions = { jobId: string; projectId: string; title: string; why: string; options: JobOption[] };

export type StuckState = "stuck" | "sent_to_lead" | "lead_gave_up";

export type StuckItem = {
  id: string;
  projectId: string;
  title: string;
  detail: string;
  state: StuckState;
  sentAt?: string;
  /** A second quiet line: "Sent to coding team lead at 2:20pm", then the Lead's "Got it". */
  note?: string;
  /** No button: it went to the Lead by itself and there is nothing for Ash to press. */
  quiet?: boolean;
};

export type SinceSummary = {
  plainText: string;
  details: string;
  /** Ash OS is still writing the nicer text: show a quiet line, the text swaps in when it is ready. */
  pending?: boolean;
};

/** Whether the data comes from a live source that can be down. The example data is always "ready". */
export type HubConnection = {
  status: "loading" | "ready" | "unreachable";
  /** A plain sentence when unreachable. */
  message?: string;
  /** True while a retry is under way. */
  retrying?: boolean;
};

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
  /** ISO time Ash was last in the app, if known. */
  lastActiveAt(): string | undefined;
  /** ISO time "Since <time>" starts from (when Ash last left), if known. */
  sinceAt(): string | undefined;
  sinceSummary(projectId?: string): SinceSummary;
  listNeeds(projectId?: string): Need[];
  /** App-wide setup items from Ash OS (connector sign-ins), counted once and never under a project. */
  listSetup(): Need[];
  /** Is the data there, loading, or is its source down? */
  connection(): HubConnection;
  /** Ask the source to try again now. */
  retry(): void;
  /** Older questions (recovered from past chats and the like): not Needs, in no count, shown collapsed. */
  listOlder(projectId?: string): Need[];
  /** Mark a Looks-right row seen. Live source only. */
  markNeedSeen?(id: string): Promise<void>;
  /** A question's options sheet, and Ash's answer (an option's index and/or his own words); the answer's receipt line. */
  question?(needId: string): Promise<HubQuestion>;
  /** Sends in the background (an option or typed answer can take a minute); progress is `answerState`. */
  answer?(needId: string, answer: HubAnswer): void;
  answerState?(needId: string): AnswerState | undefined;
  /** "Looks right" on finished critical work (actionType `accept`). Live source only. */
  acceptNeed?(id: string): Promise<void>;
  /** The project's real Needs count (shown plus Later) for its badge; absent at zero. Live source only. */
  needsCount?(projectId: string): number;
  /** Being built jobs, grouped under their Lead. Present only on the live source; the example data uses its own store. */
  listJobs?(projectId: string): HubJobGroup[];
  /** The "See options" sheet for a given-up job, and Ash's pick. Live source only. */
  jobOptions?(jobId: string): Promise<JobOptions>;
  jobAct?(jobId: string, option: string, hint?: string): Promise<void>;
  /** Ash has seen these finished jobs and left the page: they leave Being built (the record stays). */
  markJobsSeen?(jobIds: string[]): void;
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
  /** An extra reply after the picked answerer: lands quietly, no notification. */
  quiet?: boolean;
  /** The Need or stuck item this message is about (same data as Today). */
  refId?: string;
};

export type ChatConversation = {
  id: string;
  /** "Today", "Yesterday", "12 Oct". */
  when: string;
  title: string;
  /** Ash renamed it: the first message no longer names it. */
  named?: boolean;
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
  replyPending?: string;
  replyError?: string;
  replyConversationId?: string;
  replyMessageId?: string;
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
  /** Job state when not stuck or finished. Default working. */
  state?: "working" | "checking" | "needs_you" | "parked";
  /** Plain reason, shown next to the Stuck mark. */
  stuckReason?: string;
  /** "Sent to coding team lead at 2:20pm · Got it", under the reason. */
  sentNote?: string;
  /** Done jobs: opened once (then they archive themselves). */
  seen?: boolean;
  /** Minutes since its last activity (0 = now). */
  activeAgo?: number;
  /** One part of a bigger job (see HubJob.parentId); the parts fold into one row. */
  parentId?: string;
  parentTitle?: string;
  /** A folded big job: its parts, in order. */
  parts?: Worker[];
  archived?: boolean;
};

export type JobState = "working" | "checking" | "stuck" | "gave_up" | "needs_you" | "done_unseen" | "done" | "parked";
