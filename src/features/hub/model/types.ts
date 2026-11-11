// Hub data shapes. They follow the spec's "Handoff notes for Claude Code"
// (SPEC.md, H1b). The frontend only talks to `HubDataSource`; Claude Code
// replaces the mock source with the real backend.
import type { CouncilRecord } from "../../council/model/record";

/**
 * Grey icon shape that tells a project apart. Never a colour. Ash OS's set (Ash, 15 Oct: "i want to be able to change
 * the icon for the projects, i dont like ghost stuff"): no ghost; a stored "ghost" is read as the gamepad.
 */
export type ProjectIconShape =
  | "gamepad" | "sparkles" | "palette" | "gauge" | "folder" | "code" | "rocket"
  | "chart" | "briefcase" | "megaphone" | "book" | "heart" | "globe" | "bolt";

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
  /** Ash turned on "Share with my team" for this project. Only his click sets it. */
  shared?: boolean;
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
  /** A "Looks right" row: the one action is to mark it seen (`need-seen`). */
  canMarkSeen?: boolean;
};

/** A job as Ash OS reports it (Being built). Times are ISO. */
export type JobWireState =
  | "working" | "checking" | "waiting" | "stuck" | "sent_to_lead" | "lead_gave_up" | "done" | "parked"
  /** A state this app doesn't know yet (`rawState` says which): shown under its own word, never dropped. */
  | "unknown";

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
  /** Ash OS left it red but its Lead has it and nothing waits on Ash: shown as with its Lead (grey), never Needs you. */
  notAshs?: boolean;
  /** "Sent to coding team lead at 2:20pm" (stuck jobs sent to a Lead) and the Lead's "Got it". */
  sentText?: string;
  gotIt?: { at: string; text: string } | null;
  tried?: string[];
  why?: string;
  retryAt?: string;
  /** A part of a bigger job the Lead split up (its workers): the big job's id and title. Shown as one row. */
  parentId?: string;
  parentTitle?: string;
  /** Where Ash OS made the job from: `delegation:<top row id>` or `ask:<ask id>` (the app finds its own rows by it). */
  sourceRef?: string;
  /** The state word Ash OS sent when `state` is `unknown`. */
  rawState?: string;
};

/** Jobs grouped under the Mono running them, in the order Ash OS lists them (it never re-sorts). */
export type HubJobGroup = { leadId: string | null; leadName: string; projectId: string; jobs: HubJob[] };

/** A question Ash is asked (`question`). Most have no options: then the recommendation and the quick answers. */
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

/** What a sweep of the older questions closed, and one plain line saying so. */
export type OlderDismissed = { dismissed: number; receipt: string };

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
  /** The Lead it is with ("Hivra lead"), for its "With <Lead>" chip. */
  lead?: string;
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

/**
 * One section of the Today board, as Ash OS keeps it (`layout`): the shipped board unless a change moved it.
 * `latest-build` and `latest-page` are a project's own cards, drawn from that project's builds and kept pages; Ash
 * OS's board never sends them.
 */
export type TodaySectionKind = "since" | "setup" | "needs" | "being-built" | "page" | "latest-build" | "latest-page";
export type TodaySection = { id: string; kind: TodaySectionKind; title: string; pageId?: string };
/** The board Ash OS sends with nothing set (and the app draws while it has no answer). */
export const TODAY_DEFAULT: readonly TodaySection[] = [
  { id: "since", kind: "since", title: "Since you were away" },
  { id: "setup", kind: "setup", title: "Setup" },
  { id: "needs", kind: "needs", title: "Needs you" },
  { id: "being-built", kind: "being-built", title: "Being built" },
];

/** One side of a change's comparison: the hub as it is (`now`) or with the change (`preview`). */
export type HubChangeSide = { image?: string; sections: { title: string; rows: string[] }[] };
export type HubChangeState = "preview" | "applied" | "undone" | "discarded";
/** A Change the hub / Edit Today change from Ash OS's history (`changes`), newest first. Never deleted. */
export type HubChangeRecord = {
  previewId: string;
  title: string;
  by: string;
  monoId: string;
  flow: "hub" | "today" | "connect";
  projectId: string;
  state: HubChangeState;
  prompt: string;
  createdAt: string;
  appliedAt?: string;
  undoneAt?: string;
  now: HubChangeSide;
  preview: HubChangeSide;
  /** What happened to it: previewed, applied, undone, redone, discarded, and refusals with their reason (`note`). */
  log: { at: string; what: string; by: string; note?: string }[];
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
  /**
   * Sweep the old question queue: close every open older question asked more than `olderThanDays` ago (one project's
   * when given). Their asks are parked, never dropped. Live source only (`older-dismiss`).
   */
  dismissOlder?(olderThanDays: number, projectId?: string): Promise<OlderDismissed>;
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
  /** The Today board's sections in order (`layout`). Undefined until Ash OS has said (draw the shipped board). */
  todayLayout?(): TodaySection[] | undefined;
  /** Change the hub / Edit Today history, newest first (`changes`). Live source only. */
  listChanges?(): HubChangeRecord[];
}

/** What a room message is: Ash's, a Mono's, the app's quiet line ("Ash asked the team to keep going"), or a notice. */
export type ChatMessageKind = "ash" | "mono" | "system" | "notice";

/** How a Mono came to speak (shown behind its name). */
/** WP-22: lead, mentions, everyone or auto (roomModes.ts). */
export type ResponderMode = "lead" | "mentions" | "everyone" | "auto";

export type ChatPickSource =
  | "mention"
  | "only"
  | "named"
  | "lead"
  | "router"
  | "lanes"
  | "room"
  | "chime"
  | "addressed"
  | "digest"
  | "report"
  | "back"
  | "post"
  // WP-22: a room in auto mode had a quick model pick who answers; a goal run's lead chose who speaks next.
  | "auto"
  | "goal";

/**
 * One message in a group chat. `from` is "ash", a Mono id, or "app" (a system line or a notice). A notice is the room
 * never going silent: a Mono's turn that failed, ran out of budget or was stopped says so in the thread.
 */
export type ChatMessage = {
  id: string;
  from: "ash" | "app" | string;
  text: string;
  /** Absent on older messages: "ash" from Ash, else "mono". */
  kind?: ChatMessageKind;
  /** The message this one answers. */
  replyTo?: string;
  /** Acknowledgements instead of "got it" bubbles: emoji to who reacted ("ash" or Mono ids), in order. */
  reactions?: Record<string, string[]>;
  /** When it was written (epoch ms). */
  at?: number;
  /** Only stuck or given-up items carry a status. */
  status?: StuckState;
  /** An extra reply after the picked answerer: lands quietly, no notification. */
  quiet?: boolean;
  /** The Need or stuck item this message is about (same data as Today). */
  refId?: string;
  /**
   * Why this Mono spoke: how the answerer was picked, or that it chimed in, was addressed, closed a stretch (digest),
   * reported (a Lead's report, or work it delegated from the room coming back), or posted on its own (room_post).
   */
  pick?: { by: ChatPickSource; why: string };
  /** A notice about a Mono: who, and whether Try again can run its turn once more. */
  notice?: { mono?: string; retry?: boolean };
  /**
   * What Ash attached (photos, files): kept by path on this Mac (a pasted picture is saved to a file first), so the
   * Monos answering get them as they would in their own chat, and they are still there after a restart.
   */
  attachments?: RoomAttachment[];
};

/** A file on a room message: where it is on disk and what it is (never its bytes; those are read when a turn sends it). */
export type RoomAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "audio" | "file";
  size: number;
  path: string;
};

export type ChatConversation = {
  id: string;
  /** "Today", "Yesterday", "12 Oct" (from `createdAt` when it is known). */
  when: string;
  title: string;
  /** Ash renamed it: the first message no longer names it. */
  named?: boolean;
  messages: ChatMessage[];
  /** The last of Ash's messages the room has taken up; the ones after it wait for the next exchange. */
  answeredThrough?: string;
  /** When it was started (epoch ms). */
  createdAt?: number;
  /** Older messages are in the room store than were loaded. */
  more?: boolean;
};

/** A project's group chat. The Leadership team is the default one. */
export type GroupChat = {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  memberIds: string[];
  conversations: ChatConversation[];
  /** Who answers Ash first. Unset: Chief of Staff when seated, else the first member. */
  leadId?: string;
  /**
   * WP-22: who answers a message from Ash (roomModes.ts). Unset is "everyone", the room's behaviour before modes: the
   * lead answers first and every other member may add a reply.
   */
  responder?: ResponderMode;
  /** The default team was seated in it once (a Mono Ash takes out stays out). */
  seated?: boolean;
  replyPending?: string;
  replyError?: string;
  replyConversationId?: string;
  replyMessageId?: string;
  /** WP-23: the council convened in this room, when there is one. */
  council?: CouncilRecord;
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
  /** Its Lead's last turn failed, with that failure's tone: red (only Ash can fix it) reads "Needs you", grey "Can't answer". */
  leadCantAnswer?: "red" | "grey";
  steps: ActivityStep[];
  /** Id of the waiting item that already covers this worker being stuck. */
  waitingId?: string;
  /** Set when finished today. */
  finishedAt?: string;
  /** A paused job (Ash OS's "parked"): when Ash paused it, like "2:10pm" (Ash OS stamps the pause as finishedAt). */
  pausedSince?: string;
  /** Job state when not stuck or finished. Default working. */
  state?: "working" | "checking" | "waiting" | "needs_you" | "parked" | "waiting_ci" | "unknown";
  /** A state Ash OS named that this app doesn't know: its own word ("Blocked on ci"). */
  stateWord?: string;
  /** Why it waits, in plain words, for a job that isn't stuck (a worker's question): the second line. */
  stateReason?: string;
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
  /** A pull request its Mono registered (features/pr-watch): the app waits on its CI for the Mono. */
  prWatch?: { id: string; ownerSession: string; url: string; line: string };
  archived?: boolean;
  /** Where Ash OS made the job from (HubJob.sourceRef): the app finds its own delegation rows by it. */
  sourceRef?: string;
  /** The Mono running it (a live job's lead id). */
  lead?: string | null;
  /** A worker under it that is stuck (asking, stalled or failed): what makes the row Stuck, and what Ash can answer. */
  stuckWorker?: import("../../monos/model/workerStuck").StuckWorker;
};

export type JobState = "working" | "checking" | "waiting" | "stuck" | "gave_up" | "needs_you" | "done_unseen" | "done" | "parked" | "waiting_ci" | "unknown";
