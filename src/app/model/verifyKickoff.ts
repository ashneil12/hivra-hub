// The fake-Claude test bench's kickoff (scripts/hub-verify-live.mjs). A dev copy started with a verify plan
// (src-tauri/src/verify_live.rs: only a dev copy under a temporary HOME) opens a Mono on the plan's scratch project
// and sends its first message, once per run: the window's storage lives in that temporary HOME, so every restart of
// the same run finds the claim and leaves the chat to resume by itself.

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
