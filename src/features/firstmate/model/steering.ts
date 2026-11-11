// Hivra WP-14: steering and decisions in the webview (docs/hivra/work/WP-14-steering-decisions.md).
//
// The store is Rust's (src-tauri/src/steering.rs, src-tauri/src/decisions.rs): a message to a running worker is stored
// there first, then this side delivers it the way the worker's CLI allows (steer into the turn, or start it as the next
// one), and a decision lives there under its stable key. Here:
// - `planDelivery`: the one rule for how a stored message goes in (pure, tested);
// - `taskMessage` / `askPerson`: the task_message and ask_person tools (agentAppTasks.ts dispatches to them);
// - `tauriFirstMate`: the backend the tools and useSteering use.
import { invoke } from "@tauri-apps/api/core";
import type { Delegation } from "../../monos/model/delegations";
import type { Session } from "../../sessions/model/session";

/** steering.rs's event after any change: `{ids, children}`. */
export const STEERING_CHANGED = "hivra:steering-changed";
/** decisions.rs's event after any change: `{keys}`. */
export const DECISIONS_CHANGED = "hivra:decisions-changed";

export type SteerMode = "auto" | "steer" | "queue";

export type SteerMessage = {
  id: string;
  ownerSession: string;
  childSession: string;
  delegationId: string | null;
  requestId: string;
  source: "first-mate" | "decision";
  decisionKey: string | null;
  text: string;
  mode: SteerMode;
  state: "pending" | "delivered" | "failed";
  delivery: "steered" | "started" | null;
  attempts: number;
  error: string | null;
  heldAt: number | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
};

export type SteerInput = {
  ownerSession: string;
  childSession: string;
  delegationId?: string;
  requestId: string;
  text: string;
  mode?: SteerMode;
};

export type SteerOutcome =
  | { kind: "delivered"; delivery: "steered" | "started" }
  | { kind: "held" }
  | { kind: "failed"; error: string; fatal?: boolean };

export type Decision = {
  project: string;
  decisionKey: string;
  question: string;
  options: string[];
  recommended: string | null;
  askedBy: string;
  askedByMono: string | null;
  waiting: string[];
  state: "open" | "answered";
  answer: string | null;
  answeredBy: string | null;
  answeredAt: number | null;
  createdAt: number;
  updatedAt: number;
  version: number;
  /** WP-215. Why this answer was given. Absent on older rows. */
  answerReason?: string | null;
  /** WP-156. Absent on older rows the screen already has. */
  standing?: boolean;
  keys?: string[];
  retiredAt?: number | null;
  retiredReason?: string | null;
  standingId?: string;
};

export type AskInput = {
  askedBy: string;
  askedByMono?: string;
  project?: string;
  key: string;
  question: string;
  options: string[];
  recommended?: string;
  taskIds?: string[];
  /** WP-156. Invalid words are dropped by the store. */
  keys?: string[];
  force?: boolean;
  reason?: string;
};

export type AskOutcome = {
  decision: Decision;
  created: boolean;
  added: string[];
  released: SteerMessage[];
  /** Set when a standing answer was reused. Omitted by the store when it was not. */
  matched?: boolean;
  standingId?: string;
};
export type AnswerOutcome = {
  applied: boolean;
  decision: Decision | null;
  released: SteerMessage[];
  releasedTasks: string[];
};

/** The store's side, as the tools and the delivery hook use it. */
export type FirstMateBackend = {
  record(input: SteerInput): Promise<SteerMessage>;
  pending(): Promise<SteerMessage[]>;
  list(query: { childSession?: string; ownerSession?: string }): Promise<SteerMessage[]>;
  settle(id: string, outcome: SteerOutcome): Promise<{ applied: boolean; message: SteerMessage | null }>;
  ask(input: AskInput): Promise<AskOutcome>;
  answer(project: string, key: string, answer: string, by?: string, reason?: string): Promise<AnswerOutcome>;
  decisions(answered?: number): Promise<Decision[]>;
  /** WP-156: the standing-answers block for one project. Empty while the setting is off. */
  standingBrief?(project: string): Promise<string>;
};

export const tauriFirstMate: FirstMateBackend = {
  record: (input) => invoke("steering_record", { input }),
  pending: () => invoke("steering_pending"),
  list: (query) => invoke("steering_list", query),
  settle: (id, outcome) => invoke("steering_settle", { id, outcome }),
  ask: (input) => invoke("decisions_ask", { input }),
  answer: (project, key, answer, by, reason) => invoke("decisions_answer", { project, key, answer, by, reason }),
  decisions: (answered) => invoke("decisions_list", { answered }),
  standingBrief: (project) => invoke("decisions_standing_brief", { project }),
};

/** What delivery knows about the worker's chat. Undefined: the chat is gone. */
export type WorkerChat = Pick<Session, "busy"> & {
  /** Its CLI can take a message into a running turn. */
  canSteer: boolean;
  /** The message's request id is already in its transcript or queue (a delivery that wasn't recorded). */
  alreadyIn: boolean;
};

export type Plan =
  | { kind: "steer" }
  | { kind: "start" }
  | { kind: "hold" }
  | { kind: "done"; delivery: "steered" | "started" }
  | { kind: "fail"; error: string };

/**
 * How a stored message goes into its worker's chat now. An idle chat takes it as a new turn; a busy one takes it into
 * the running turn when its CLI can and the sender didn't ask to wait; otherwise it is held for the next turn.
 */
export function planDelivery(message: Pick<SteerMessage, "mode" | "heldAt">, chat: WorkerChat | undefined): Plan {
  if (!chat) return { kind: "fail", error: "The worker's chat is gone." };
  if (chat.alreadyIn) return { kind: "done", delivery: chat.busy ? "steered" : "started" };
  if (!chat.busy) return { kind: "start" };
  if (message.mode !== "queue" && chat.canSteer) return { kind: "steer" };
  return { kind: "hold" };
}

/** The request id a steering message goes into the chat under (the transcript's `appRequestId`). */
export const steerRequestId = (message: Pick<SteerMessage, "id">) => `steer-${message.id}`;

/** What the first mate reads back about a message. */
export function messageLine(message: SteerMessage): string {
  if (message.state === "delivered")
    return message.delivery === "steered" ? "Steered into the worker's running turn." : "Went in as the worker's next turn.";
  if (message.state === "failed") return `Not delivered: ${message.error ?? "it could not go in"}.`;
  if (message.heldAt) return "Held: the worker is mid-turn and its CLI can't take it now, so it goes in as its next turn.";
  return "Stored; it goes in as soon as the worker's chat can take it.";
}

/** The tools' side of the store (AgentAppTasksHost.firstMate). */
export type FirstMateTasksHost = {
  backend: FirstMateBackend;
  /** Resolves with the message once it leaves plain pending (delivered, held or failed), or as it stands after `ms`. */
  settled?(message: SteerMessage, ms: number): Promise<SteerMessage>;
};

const MODES = ["auto", "steer", "queue"] as const;

/** Caps refuse, never cut: the store checks the length and says how long it may be. */
function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

/** task_message: a message to one of the caller's running tasks, stored first, then delivered. */
export async function taskMessage(
  source: Pick<Session, "id">,
  requestId: string,
  input: Record<string, unknown>,
  row: Delegation,
  host: FirstMateTasksHost,
): Promise<Record<string, unknown>> {
  if (row.state !== "running" && row.state !== "question")
    throw new Error(`Task ${row.id} is no longer running; start a new one with delegate_task instead.`);
  const text = nonEmpty(input.text, "text");
  const mode = input.whenBusy === undefined ? "auto" : input.whenBusy;
  if (!MODES.includes(mode as SteerMode)) throw new Error("whenBusy must be auto, steer or queue");
  const stored = await host.backend.record({
    ownerSession: source.id,
    childSession: row.childSession,
    delegationId: row.id,
    requestId,
    text,
    mode: mode as SteerMode,
  });
  const now = host.settled ? await host.settled(stored, 4_000).catch(() => stored) : stored;
  return { taskId: row.id, messageId: now.id, state: now.state, ...(now.heldAt ? { held: true } : {}), note: messageLine(now) };
}

function options(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((option) => typeof option === "string"))
    throw new Error("options must be a list of 2 to 6 short answers");
  return value as string[];
}

/** ask_person: put one question to the person under a stable key. Asking again with the same key changes nothing. */
export async function askPerson(
  source: Pick<Session, "id">,
  input: Record<string, unknown>,
  where: { mono?: string; project?: string },
  ownTasks: Delegation[],
  host: FirstMateTasksHost,
): Promise<Record<string, unknown>> {
  return (await askPersonRecorded(source, input, where, ownTasks, host)).result;
}

/**
 * WP-172: askPerson, plus who the store recorded the answer from (`answeredBy`, null while it is open). A caller that
 * acts only on the person's own answer reads it here: a chat answering for the model is not the person.
 */
export async function askPersonRecorded(
  source: Pick<Session, "id">,
  input: Record<string, unknown>,
  where: { mono?: string; project?: string },
  ownTasks: Delegation[],
  host: FirstMateTasksHost,
): Promise<{ result: Record<string, unknown>; answeredBy: string | null; question: string; options: string[] }> {
  const outcome = await host.backend.ask({
    askedBy: source.id,
    ...(where.mono ? { askedByMono: where.mono } : {}),
    ...(where.project ? { project: where.project } : {}),
    key: nonEmpty(input.key, "key"),
    question: nonEmpty(input.question, "question"),
    options: options(input.options),
    ...(typeof input.recommended === "string" ? { recommended: input.recommended } : {}),
    taskIds: ownTasks.map((row) => row.id),
    ...(Array.isArray(input.keys) ? { keys: input.keys.filter((key) => typeof key === "string") } : {}),
    ...(input.force === true ? { force: true } : {}),
    ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
  });
  let d = outcome.decision;
  if (outcome.matched) {
    const id = outcome.standingId ?? d.standingId ?? "";
    return {
      result: {
        key: d.decisionKey,
        state: "answered",
        answer: d.answer,
        standingId: id,
        matched: true,
        note: `A standing answer ${id} to a similar question: guidance, not permission. If it does not apply, ask again with force true and a one-line reason.`,
      },
      answeredBy: d.answeredBy,
      question: d.question,
      options: d.options,
    };
  }
  // The person answered it in this chat: their words are the answer, recorded once, and the waiting tasks carry on.
  if (input.answer !== undefined && d.state === "open") {
    const words = nonEmpty(input.answer, "answer");
    const answered = await host.backend.answer(d.project, d.decisionKey, words, `chat:${source.id}`);
    if (answered.decision) d = answered.decision;
    if (answered.applied)
      return {
        result: {
          key: d.decisionKey,
          state: d.state,
          answer: d.answer,
          released: answered.releasedTasks,
          note: answered.releasedTasks.length
            ? `Recorded their answer; ${answered.releasedTasks.length} waiting task(s) have it and carry on.`
            : "Recorded their answer.",
        },
        answeredBy: d.answeredBy,
        question: d.question,
        options: d.options,
      };
  }
  const base = { key: d.decisionKey, state: d.state, waiting: d.waiting };
  if (d.state === "answered")
    return {
      result: {
        ...base,
        answer: d.answer,
        note: `Already answered: ${d.answer}. Carry on from it; don't ask again.${outcome.released.length ? " The tasks you named have it too." : ""}`,
      },
      answeredBy: d.answeredBy,
      question: d.question,
      options: d.options,
    };
  return {
    result: {
      ...base,
      created: outcome.created,
      note: outcome.created
        ? "Asked. It waits in the person's Inbox; their answer comes back to you and to the tasks waiting on it as a new turn. Tell them in one line what you asked, then end your turn."
        : "Already asked under this key; nothing changed. Their answer comes back to you as a new turn.",
    },
    answeredBy: d.answeredBy,
    question: d.question,
    options: d.options,
  };
}

/** What delivery needs from the app (App.tsx builds it; tests pass a fake). */
export type DeliveryDeps = {
  backend: FirstMateBackend;
  /** The worker's chat, loaded if it has to be; undefined when it is gone. */
  chat(id: string): Promise<Pick<Session, "id" | "busy" | "blocks" | "queuedMessages" | "harness"> | undefined>;
  // WP-134b: registryAgentId is set on a More agents chat, which cannot be steered.
  canSteer(chat: Pick<Session, "harness" | "registryAgentId">): boolean;
  /** Put the text into the chat: into the running turn (`steer`) or as a new turn. False: it didn't take it. */
  submit(id: string, text: string, options: { appRequestId: string; steer: boolean }): Promise<boolean>;
  now?(): number;
};

/** A try that failed waits this long before the next one (the store gives up after its own number of tries). */
export const RETRY_AFTER_MS = 30_000;

/** What the worker reads. A first mate's words say whose they are; a decision's text already does. */
export function deliveredText(message: Pick<SteerMessage, "source" | "text" | "ownerSession" | "childSession">): string {
  if (message.source === "decision" || message.ownerSession === message.childSession) return message.text;
  return `Message from your first mate (it outranks your brief where they differ):\n${message.text}`;
}

const isIn = (chat: Pick<Session, "blocks" | "queuedMessages">, requestId: string) =>
  chat.blocks.some((block) => block.appRequestId === requestId) ||
  !!chat.queuedMessages?.some((queued) => queued.id === requestId || queued.appRequestId === requestId);

/** Try one stored message once, and record what happened. */
export async function deliverOne(message: SteerMessage, deps: DeliveryDeps): Promise<SteerOutcome | undefined> {
  const requestId = steerRequestId(message);
  const chat = await deps.chat(message.childSession).catch(() => undefined);
  const plan = planDelivery(
    message,
    chat && { busy: chat.busy, canSteer: deps.canSteer(chat), alreadyIn: isIn(chat, requestId) },
  );
  let outcome: SteerOutcome | undefined;
  switch (plan.kind) {
    case "fail":
      outcome = { kind: "failed", error: plan.error, fatal: true };
      break;
    case "done":
      outcome = { kind: "delivered", delivery: plan.delivery };
      break;
    case "hold":
      // Already held: it waits for the worker's next idle moment without another write.
      outcome = message.heldAt ? undefined : { kind: "held" };
      break;
    case "steer":
    case "start": {
      const steer = plan.kind === "steer";
      const ok = await deps
        .submit(message.childSession, deliveredText(message), { appRequestId: requestId, steer })
        .catch(() => false);
      outcome = ok
        ? { kind: "delivered", delivery: steer ? "steered" : "started" }
        : { kind: "failed", error: "The worker's chat didn't take it" };
      break;
    }
  }
  if (outcome) await deps.backend.settle(message.id, outcome);
  return outcome;
}

/** Every pending message, oldest first, one worker chat at a time in order (a later one never overtakes). */
export async function drainPending(deps: DeliveryDeps): Promise<number> {
  const pending = await deps.backend.pending();
  const blocked = new Set<string>();
  let delivered = 0;
  const now = (deps.now ?? Date.now)();
  for (const message of pending) {
    if (blocked.has(message.childSession)) continue;
    if (message.attempts > 0 && now - message.updatedAt < RETRY_AFTER_MS) {
      blocked.add(message.childSession);
      continue;
    }
    const outcome = await deliverOne(message, deps);
    if (outcome?.kind === "delivered") {
      delivered++;
      // It started a turn: the next one goes into that turn, or after it, on the next pass.
      if (outcome.delivery === "started") blocked.add(message.childSession);
    }
    // Held or failed this time: the messages behind it wait too.
    else blocked.add(message.childSession);
  }
  return delivered;
}
