// The hub store's transport: one interface the store reads and writes through, so it can be tested against a
// stand-in. The app's own transport answers everything locally (localHub/localTransport.ts, WP-04); the Ash OS bridge
// that used to sit behind it is retired (its last code is tagged `archive/ash-os-bridge`).

/** `server`: the answer was a failure on the other side (kept for stand-ins). */
export type HubErrorKind = "unreachable" | "timeout" | "unauthorized" | "refused" | "server" | "error";

/** A failed call, in plain words. `kind` tells "couldn't be reached" from "said no". */
export class HubCallError extends Error {
  readonly kind: HubErrorKind;
  constructor(kind: HubErrorKind, message: string) {
    super(message);
    this.name = "HubCallError";
    this.kind = kind;
  }
  /** True when the other side could not be reached: the calm "isn't running" state. */
  get isDown(): boolean {
    return this.kind === "unreachable" || this.kind === "timeout" || this.kind === "unauthorized";
  }
}

const KINDS: readonly string[] = ["unreachable", "timeout", "unauthorized", "refused", "server", "error"];

/** What a transport rejects with is `{kind, message}`; anything else means it couldn't be reached. */
export function toHubError(raw: unknown): HubCallError {
  if (raw instanceof HubCallError) return raw;
  if (raw && typeof raw === "object" && "kind" in raw && "message" in raw) {
    const { kind, message } = raw as { kind: unknown; message: unknown };
    if (typeof kind === "string" && KINDS.includes(kind) && typeof message === "string") {
      return new HubCallError(kind as HubErrorKind, message);
    }
  }
  return new HubCallError("unreachable", raw instanceof Error && raw.message ? raw.message : "The app couldn't be read.");
}

/** One change from the transport's feed. */
export type HubFeedEvent = {
  seq: number;
  kind: string;
  ref?: string | null;
  topics: string[];
  at?: string;
  project?: string;
};

/** The feed's connection. `reset` means the store's cursor was ahead: read everything again. */
export type HubFeedState = { connected: boolean; latest?: number; reset?: boolean; message?: string; kind?: string };

export type HubFeedHandlers = {
  onEvent(event: HubFeedEvent): void;
  onState(state: HubFeedState): void;
};

export interface HubTransport {
  /** One call; resolves with its answer. */
  call<T = unknown>(action: string, payload?: Record<string, unknown>): Promise<T>;
  /** Open the live feed after `after`. Returns a function that closes it. */
  openFeed(after: number, handlers: HubFeedHandlers): () => void;
}
