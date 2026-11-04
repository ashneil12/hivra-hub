// Hivra WP-15: Retry sends the same brief again through tasks.delegate.
// The redo flow notes the new attempt on the old row. This builds that request.
// It does not write the ledger itself.

import { withLegacyBriefParts } from "../../firstmate/model/brief";

export type RetryRow = {
  id: string;
  brief?: string | null;
  goal?: string | null;
  title?: string | null;
};

/** The delegate input for one more attempt, or null when there is no brief to send. */
export function retryDelegateInput(row: RetryRow): Record<string, unknown> | null {
  const brief = (row.brief ?? "").trim();
  if (!brief) return null;
  const goal = (row.goal ?? "").trim();
  const title = (row.title ?? "").trim();
  return withLegacyBriefParts(
    {
      brief,
      ...(goal ? { goal } : {}),
      ...(title ? { title } : {}),
      redoes: row.id,
    },
    title || "The job",
  );
}

/** `redo-<worker>-<nonce>`, short enough for tasks.delegate. The nonce is not a counter. */
export function retryRequestId(rowId: string, nonce?: string): string {
  const id =
    rowId
      .trim()
      .slice(0, 40)
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "worker";
  const extra = (nonce ?? newNonce()).trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!extra) throw new Error("missing nonce");
  const request = `redo-${id}-${extra}`.slice(0, 100);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(request)) throw new Error("missing nonce");
  return request;
}

export async function retrySameBrief(
  row: RetryRow,
  run: (requestId: string, input: Record<string, unknown>) => Promise<unknown>,
  nonce?: string,
): Promise<void> {
  const input = retryDelegateInput(row);
  if (!input) throw new Error("missing brief");
  await run(retryRequestId(row.id, nonce), input);
}

type CrewDelegate = (
  ownerSession: string,
  requestId: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

let registered: CrewDelegate | null = null;

/** The app registers the tasks.delegate path. A test, or a closed window, clears it. */
export function registerCrewDelegate(fn: CrewDelegate | null): void {
  registered = fn;
}

export function crewDelegate(
  ownerSession: string,
  requestId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (!registered) throw new Error("retry is not available");
  return registered(ownerSession, requestId, input);
}

function newNonce(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
