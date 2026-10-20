// The fake-Claude test bench's kickoff (scripts/hub-verify-live.mjs). A dev copy started with a verify plan
// (src-tauri/src/verify_live.rs: only a dev copy under a temporary HOME) opens a Mono on the plan's scratch project
// (or an existing one, such as the built-in Chief of Staff, when the plan names it) and sends its first message, once
// per run: the window's storage lives in that temporary HOME, so every restart of the same run finds the claim and
// leaves the chat to resume by itself.

import { appIdentity, type AppIdentity, type VerifyPlan } from "./appIdentity";

const CLAIM_KEY = "monocode:verify-live-kickoff";

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
 * The Mono the kickoff goes to: a new one on the plan's project, or (`monoId`) that existing Mono once it works on the
 * project. The hub makes its built-in team and ties it to the projects Ash OS lists a moment after the window is up,
 * so this waits for that (up to `timeoutMs`); null when it never happens, and the walk notices nothing was sent.
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
