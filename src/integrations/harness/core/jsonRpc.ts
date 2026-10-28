import { writeChild } from "./child";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type JsonRpcId = number | string;

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

// A child wedged hard enough to block stdin writes is unrecoverable; the
// write deadline fails the request so the caller can recycle the generation.
const WRITE_TIMEOUT_MS = 15_000;

export type JsonRpcHandlers = {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (
    id: JsonRpcId,
    method: string,
    params: unknown,
  ) => void | Promise<void>;
};

/**
 * How long a running turn may go without one line from its harness before it is given up on (28 Oct blind run: a
 * 30-minute cap on the whole turn killed three workers that were still working). Any message from the child counts,
 * a streamed update, a tool event or a request of its own; while it waits on our answer (an approval or a question)
 * the clock stands still. The hub's own hour check (workerStuck.ts) judges whether the work moves; this only catches
 * a process that has gone truly silent.
 */
export const TURN_IDLE_TIMEOUT_MS = 60 * 60_000;

/** How long an unanswered request of the child's keeps the silence clock still. */
const OWED_HOLD_MS = 24 * 60 * 60_000;

export type JsonRpcRequestOptions = {
  /** timeoutMs is a window of silence, reset by every message from the child, not a cap on the request. */
  idle?: boolean;
};

export type JsonRpcClientOptions = {
  /** Include `"jsonrpc":"2.0"` on outbound messages. Default true (ACP). Codex omits it. */
  includeJsonrpc?: boolean;
  label?: string;
};

/**
 * Bidirectional JSON-RPC / JSONL client over a harness child process stdin/stdout.
 * Supports numeric and string request ids; Codex app-server uses headerless frames.
 */
export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private readonly includeJsonrpc: boolean;
  private readonly label: string;
  /** When the child last said anything, or we last answered it. */
  private lastHeard = Date.now();
  /**
   * The child's own requests we haven't answered yet, by when they came: its turn waits on us (Ash's approval or
   * answer), so it isn't silent. Only for OWED_HOLD_MS, so a request nobody answers can't hold a turn open forever.
   */
  private readonly owed = new Map<string, number>();

  constructor(
    private readonly sessionId: string,
    private readonly handlers: JsonRpcHandlers,
    options: JsonRpcClientOptions = {},
  ) {
    this.includeJsonrpc = options.includeJsonrpc !== false;
    this.label = options.label ?? "rpc";
  }

  pushLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      console.debug(
        `[${this.label} ${this.sessionId}] non-json`,
        trimmed.slice(0, 200),
      );
      return;
    }
    this.handle(msg);
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    const err = error ?? new Error("Harness process exited");
    this.owed.clear();
    this.rejectPending(err);
  }

  /** Drop in-flight client requests so a cancelled turn can unwind. */
  rejectPending(error?: Error) {
    const err = error ?? new Error("cancelled");
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async request<T>(
    method: string,
    params?: unknown,
    timeoutMs = 0,
    options: JsonRpcRequestOptions = {},
  ): Promise<T> {
    if (this.closed) throw new Error("Harness process is not running");
    const id = this.nextId++;
    const key = String(id);
    const started = Date.now();
    // Register before writing. A local harness can answer quickly enough for
    // Tauri to deliver its stdout event before harness_write resolves; adding
    // the pending entry after send() silently discarded that response.
    const response = new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = (message: string) => {
        this.pending.delete(key);
        reject(new Error(message));
      };
      // Idle: fire only once the child has been silent for the whole window (and owes us nothing), else look again
      // when the window since its last word would end.
      const watchSilence = (delay: number) => {
        timer = setTimeout(() => {
          if (!this.pending.has(key)) return;
          const now = Date.now();
          const waitsOnUs = [...this.owed.values()].some((at) => now - at < OWED_HOLD_MS);
          const quiet = now - Math.max(this.lastHeard, started);
          if (!waitsOnUs && quiet >= timeoutMs)
            return fail(`${method} got no word from the harness for ${Math.round(timeoutMs / 60_000)} minutes and timed out`);
          watchSilence(waitsOnUs ? timeoutMs : Math.max(1, timeoutMs - quiet));
        }, delay);
      };
      if (timeoutMs > 0) {
        if (options.idle) watchSilence(timeoutMs);
        else timer = setTimeout(() => fail(`${method} timed out`), timeoutMs);
      }
      this.pending.set(key, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
    });
    // The deadline may settle `response` while we are still suspended in
    // send() below; mark it handled so that window can't surface as an
    // unhandled rejection. The promise returned to the caller still settles.
    response.catch(() => undefined);
    try {
      await this.send({
        ...(this.includeJsonrpc ? { jsonrpc: "2.0" } : {}),
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return;
    await this.send({
      ...(this.includeJsonrpc ? { jsonrpc: "2.0" } : {}),
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    this.answered(id);
    await this.send({
      ...(this.includeJsonrpc ? { jsonrpc: "2.0" } : {}),
      id,
      result,
    });
  }

  async respondError(
    id: JsonRpcId,
    error: { code: number; message: string; data?: unknown },
  ): Promise<void> {
    this.answered(id);
    await this.send({
      ...(this.includeJsonrpc ? { jsonrpc: "2.0" } : {}),
      id,
      error,
    });
  }

  private answered(id: JsonRpcId) {
    this.owed.delete(String(id));
    this.lastHeard = Date.now();
  }

  private async send(payload: object): Promise<void> {
    // Bound the write: a child that stops draining stdin must not let a
    // blocked harness_write outlive the request's own deadline (or wedge a
    // cancellation waiting on the session/cancel notify).
    const line = JSON.stringify(payload);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        writeChild(this.sessionId, line),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("harness write timed out")),
            WRITE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handle(msg: JsonRpcMessage) {
    this.lastHeard = Date.now();
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const key = String(msg.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      if (msg.error) {
        pending.reject(
          new Error(
            msg.error.message || `${this.label} error ${msg.error.code ?? ""}`,
          ),
        );
        return;
      }
      pending.resolve(msg.result);
      return;
    }

    if (msg.method && msg.id != null) {
      this.owed.set(String(msg.id), Date.now());
      void this.handlers.onRequest?.(msg.id, msg.method, msg.params);
      return;
    }

    if (msg.method) {
      this.handlers.onNotification?.(msg.method, msg.params);
    }
  }
}
