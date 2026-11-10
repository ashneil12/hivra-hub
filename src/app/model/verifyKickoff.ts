// The fake-Claude test bench's kickoff (scripts/hub-verify-live.mjs). A dev copy started with a verify plan
// (src-tauri/src/verify_live.rs: only a dev copy under a temporary HOME) opens a Mono on the plan's scratch project
// (or an existing one, when the plan names its id) and sends its first message, once per run: the window's storage
// lives in that temporary HOME, so every restart of the same run finds the claim and leaves the chat to resume by
// itself.

import { invoke } from "@tauri-apps/api/core";
import { appIdentity, type AppIdentity, type VerifyPlan } from "./appIdentity";

const CLAIM_KEY = "monocode:verify-live-kickoff";

/** Where a kickoff step goes: the driver's answer folder (verify_live.rs `verify_live_done`). Tests pass their own. */
export type KickoffTraceSink = (id: string, step: Record<string, unknown>) => Promise<unknown>;

let traced = 0;

/**
 * One step of the kickoff, kept for the bench as `<driver>/done/kickoff-<n>-<step>.json`: the window's console isn't
 * kept, and a run whose kickoff never reaches the fake Claude has to say where it stopped (pending, waiting for the Mono,
 * opened, sent). Only a dev copy whose plan has a driver; a step that can't be written is dropped.
 */
export function traceVerifyKickoff(
  step: string,
  detail: Record<string, unknown> = {},
  sink: KickoffTraceSink = (id, result) => invoke("verify_live_done", { id, result }),
  identity: AppIdentity | null = appIdentity(),
): void {
  const verify = identity?.kind === "dev" ? identity.verify : undefined;
  if (!verify?.driver) return;
  traced += 1;
  const id = `kickoff-${String(traced).padStart(3, "0")}-${step}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  void Promise.resolve()
    .then(() => sink(id, { step, runId: verify.runId, at: Date.now(), ...detail }))
    .catch(() => undefined);
}

/** The kickoff this window should send, or none (no plan, or this run's was already sent). */
export function pendingVerifyKickoff(
  identity: AppIdentity | null = appIdentity(),
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): NonNullable<VerifyPlan["kickoff"]> & { runId: string } | null {
  const verify = identity?.kind === "dev" ? identity.verify : undefined;
  if (!verify?.kickoff) return null;
  try {
    if (storage?.getItem(CLAIM_KEY) === verify.runId) return null;
  } catch {
    // No storage: send it; a restart then sends it again, which the scenario notices.
  }
  return { ...verify.kickoff, runId: verify.runId };
}

/** Record that this run's kickoff went out. */
export function claimVerifyKickoff(
  runId: string,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(CLAIM_KEY, runId);
  } catch {
    // see pendingVerifyKickoff
  }
}

/** What picking the kickoff's Mono needs from the window (tests pass their own). */
export type VerifyMonoHost = {
  /** A new Mono on the project, with this name: its id. */
  create(project: string, name: string): string;
  /** Whether that Mono exists and works on the project. */
  ready(monoId: string, project: string): boolean;
  sleep?(ms: number): Promise<void>;
  now?(): number;
};

/**
 * The Mono the kickoff goes to: a new one on the plan's project, or (`monoId`) an existing one once it works on the
 * project. Waits for the one it names (up to `timeoutMs`); null when it never appears, and the walk notices nothing was
 * sent.
 *
 * WP-05: a Mono's id is fresh every time, so a plan names none; the app makes the Mono from the plan's name.
 */
export async function verifyKickoffMono(
  kickoff: Pick<NonNullable<VerifyPlan["kickoff"]>, "project" | "monoName" | "monoId">,
  host: VerifyMonoHost,
  timeoutMs = 60_000,
): Promise<string | null> {
  if (!kickoff.monoId) return host.create(kickoff.project, kickoff.monoName);
  const now = host.now ?? Date.now;
  const sleep = host.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    if (host.ready(kickoff.monoId, kickoff.project)) return kickoff.monoId;
    if (now() >= deadline) return null;
    await sleep(500);
  }
}

const MESSAGES_KEY = "monocode:verify-live-messages";

/**
 * One of Ash's messages the bench sends mid-run (the plan's messages file, scripts/hub-verify-live.mjs):
 * typed into that Mono's chat the way Ash types, so it takes his path (it goes first, and steers a running turn).
 */
export type VerifyMessage = {
  id: string;
  monoId: string;
  prompt: string;
  /** Instead of a Mono's chat: a group room (its id, or a project id for that project's Leadership team). */
  room?: string;
  /** Instead of a Mono's chat: a new chat in this project's coding team (its project id), as Ash starts one there. */
  codingTeam?: string;
  /**
   * Instead of an existing Mono's chat: a new Mono Ash makes (New mono) with this name, on this project folder if one is
   * given, and its first message. Every Mono briefs coding teams and keeps its own team (hub/model/monoTeams.ts), not
   * only the built-in team, so the bench proves it with one of Ash's own.
   */
  newMono?: { name: string; project?: string };
};

/** The run whose messages this window sends: a dev copy's plan only (the daily app never has one). */
export function verifyRun(identity: AppIdentity | null = appIdentity()): string | null {
  return identity?.kind === "dev" && identity.verify?.runId ? identity.verify.runId : null;
}

function sentMessages(runId: string, storage: Pick<Storage, "getItem"> | undefined): Set<string> {
  try {
    const saved = JSON.parse(storage?.getItem(MESSAGES_KEY) ?? "null") as { runId?: unknown; sent?: unknown } | null;
    return saved?.runId === runId && Array.isArray(saved.sent) ? new Set(saved.sent.filter((id): id is string => typeof id === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * The bench's list, whichever shape it came in: the verify command returns the array itself, and an older stub
 * wrapped the same list as `{ messages }`.
 */
function verifyMessageList(answer: unknown): unknown[] | null {
  if (Array.isArray(answer)) return answer;
  const wrapped = (answer as { messages?: unknown } | null)?.messages;
  return Array.isArray(wrapped) ? wrapped : null;
}

/** The messages the bench lists that this run hasn't sent yet, in order. */
export function unsentVerifyMessages(
  runId: string,
  answer: unknown,
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): VerifyMessage[] {
  const list = verifyMessageList(answer);
  if (!list) return [];
  const sent = sentMessages(runId, storage);
  return list.flatMap((entry: unknown) => {
    const m = entry as Partial<VerifyMessage> | null;
    const room = typeof m?.room === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(m.room) ? m.room : undefined;
    const codingTeam =
      typeof m?.codingTeam === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(m.codingTeam) ? m.codingTeam : undefined;
    const asked = m?.newMono as { name?: unknown; project?: unknown } | undefined;
    const newMono =
      asked && typeof asked.name === "string" && asked.name.trim() && asked.name.length <= 40
        ? {
            name: asked.name.trim(),
            ...(typeof asked.project === "string" && asked.project.startsWith("/") && asked.project.length <= 4096
              ? { project: asked.project }
              : {}),
          }
        : undefined;
    return m &&
      typeof m.id === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(m.id) &&
      ((typeof m.monoId === "string" && m.monoId) || room || codingTeam || newMono) &&
      typeof m.prompt === "string" &&
      m.prompt.trim() &&
      m.prompt.length <= 20_000 &&
      !sent.has(m.id)
      ? [
          {
            id: m.id,
            monoId: typeof m.monoId === "string" ? m.monoId : "",
            prompt: m.prompt,
            ...(room ? { room } : {}),
            ...(codingTeam ? { codingTeam } : {}),
            ...(newMono ? { newMono } : {}),
          },
        ]
      : [];
  });
}

/** Record that one went out, so a restart of the same run never sends it again. */
export function claimVerifyMessage(
  runId: string,
  id: string,
  storage: (Pick<Storage, "getItem"> & Pick<Storage, "setItem">) | undefined = globalThis.localStorage,
): void {
  const sent = sentMessages(runId, storage);
  sent.add(id);
  try {
    storage?.setItem(MESSAGES_KEY, JSON.stringify({ runId, sent: [...sent] }));
  } catch {
    // No storage: a restart may send it again, which the walk notices.
  }
}

/**
 * Look for the bench's messages from Ash every second while a verify plan runs, and send each once: `send` opens the
 * Mono's chat and submits the prompt as Ash. Returns a stop.
 */
export function watchVerifyMessages(
  runId: string,
  host: {
    list(): Promise<unknown>;
    send(message: VerifyMessage): Promise<void>;
    everyMs?: number;
  },
): () => void {
  let busy = false;
  // Also in memory: without storage a message would otherwise go out every second.
  const sent = new Set<string>();
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const answer = await host.list().catch(() => null);
      for (const message of unsentVerifyMessages(runId, answer)) {
        if (sent.has(message.id)) continue;
        sent.add(message.id);
        claimVerifyMessage(runId, message.id);
        await host.send(message).catch((error: unknown) => console.error("verify message", message.id, error));
      }
    })().finally(() => {
      busy = false;
    });
  }, host.everyMs ?? 1_000);
  return () => clearInterval(timer);
}
