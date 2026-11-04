// Hivra WP-15: Stop uses tasks.cancel, as the row's owner, the same way Retry uses tasks.delegate.

export const CREW_STOP_REASON = "Stopped from the crew tab";

type CrewCancel = (
  ownerSession: string,
  requestId: string,
  input: { taskId: string; reason: string },
) => Promise<unknown>;

let registered: CrewCancel | null = null;

/** The app registers the tasks.cancel path. A test, or a closed window, clears it. */
export function registerCrewCancel(fn: CrewCancel | null): void {
  registered = fn;
}

export function crewCancel(
  ownerSession: string,
  requestId: string,
  input: { taskId: string; reason: string },
): Promise<unknown> {
  if (!registered) throw new Error("stop is not available");
  return registered(ownerSession, requestId, input);
}

/** `stop-<worker>-<nonce>`, short enough for a control request. The nonce is not a counter. */
export function stopRequestId(rowId: string, nonce?: string): string {
  const id =
    rowId
      .trim()
      .slice(0, 40)
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "worker";
  const extra = (nonce ?? newNonce()).trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (!extra) throw new Error("missing nonce");
  const request = `stop-${id}-${extra}`.slice(0, 100);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(request)) throw new Error("missing nonce");
  return request;
}

function newNonce(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
