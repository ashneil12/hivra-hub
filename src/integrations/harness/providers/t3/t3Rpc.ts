// T3 Code's client wire, as its own apps speak it: a bearer token buys a one-time ticket, the ticket opens a
// WebSocket, and each frame is one JSON message (`Request` out; `Chunk`, `Exit`, `Pong` in). Nothing here knows what
// the calls mean (t3Turn.ts does); it only keeps requests and their answers together.

export type T3Rpc = {
  /** One request, one answer. */
  call<T = unknown>(tag: string, payload: unknown): Promise<T>;
  /**
   * A request the server answers with a stream. `onValue` gets each value in order, one at a time; it ends the stream
   * by returning false. Resolves when the stream ends for any reason but a failure.
   */
  stream(
    tag: string,
    payload: unknown,
    onValue: (value: unknown) => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** A plain GET on the server's HTTP API, as JSON. */
  get<T = unknown>(path: string): Promise<T>;
  close(): void;
};

export type T3Socket = {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type T3RpcDeps = {
  fetch: typeof fetch;
  socket: (url: string) => T3Socket;
  /** How often a quiet connection says it is still there. */
  pingMs?: number;
};

/** The protocol version this client speaks (T3 `ORCHESTRATION_PROTOCOL_VERSION`). */
export const T3_PROTOCOL = 2;
const PROTOCOL_HEADER = "x-t3-orchestration-protocol";

type Pending = {
  onValue?: (value: unknown) => boolean | Promise<boolean>;
  /** Values are handled one at a time, in order, even when a handler waits on something. */
  tail: Promise<void>;
  stopped: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Exit =
  | { _tag: "Success"; value: unknown }
  | { _tag: "Failure"; cause: Array<{ _tag: string; error?: unknown; defect?: unknown }> };

/** The innermost reason an error of the engine carries, when it wraps one. */
function rootReason(error: object): string | undefined {
  let reason: string | undefined;
  let at: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; depth < 8 && at && typeof at === "object"; depth += 1) {
    const message = (at as { message?: unknown }).message;
    if (typeof message === "string" && message) reason = message;
    at = (at as { cause?: unknown }).cause;
  }
  return reason;
}

/** What a failed call says, in words a chat can show. */
export function t3FailureMessage(exit: Exit): string {
  if (exit._tag !== "Failure") return "";
  for (const part of exit.cause) {
    const value = part.error ?? part.defect;
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object") {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string" && message) {
        // The engine wraps its reason ("Failed to mutate project." around "Workspace root does not exist: ...").
        const reason = rootReason(value);
        return reason && reason !== message ? `${message} ${reason}` : message;
      }
      const tag = (value as { _tag?: unknown })._tag;
      if (typeof tag === "string") return tag;
    }
    if (part._tag === "Interrupt") return "The engine stopped the request.";
  }
  return "The engine refused the request.";
}

export function connectT3(origin: string, token: string, deps: T3RpcDeps): T3Rpc {
  const headers = { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(T3_PROTOCOL) };
  const pending = new Map<string, Pending>();
  let socket: Promise<T3Socket> | undefined;
  let nextId = 0;
  let ping: ReturnType<typeof setInterval> | undefined;

  const failAll = (reason: string) => {
    for (const request of pending.values()) request.reject(new Error(reason));
    pending.clear();
    if (ping) clearInterval(ping);
    ping = undefined;
    socket = undefined;
  };

  const receive = (opened: T3Socket, frame: Record<string, unknown>) => {
    const id = String(frame.requestId ?? "");
    const request = pending.get(id);
    if (frame._tag === "Chunk") {
      // Every chunk is acknowledged, or the server holds the rest of the stream back.
      opened.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
      if (!request?.onValue || request.stopped) return;
      const onValue = request.onValue;
      for (const value of frame.values as unknown[]) {
        request.tail = request.tail.then(async () => {
          if (request.stopped) return;
          if ((await onValue(value)) === false) {
            request.stopped = true;
            pending.delete(id);
            opened.send(JSON.stringify({ _tag: "Interrupt", requestId: frame.requestId }));
            request.resolve(undefined);
          }
        });
        request.tail.catch((error: unknown) => {
          request.stopped = true;
          pending.delete(id);
          request.reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
      return;
    }
    if (frame._tag === "Exit" && request) {
      const exit = frame.exit as Exit;
      void request.tail
        .then(() => {
          if (request.stopped) return;
          pending.delete(id);
          if (exit._tag === "Success") request.resolve(exit.value);
          else request.reject(new Error(t3FailureMessage(exit)));
        })
        .catch(() => undefined);
      return;
    }
    if (frame._tag === "Defect" || frame._tag === "ClientProtocolError") failAll("The engine closed the connection.");
  };

  const open = (): Promise<T3Socket> => {
    socket ??= (async () => {
      const response = await deps.fetch(`${origin}/api/auth/websocket-ticket`, { method: "POST", headers });
      if (!response.ok) throw new Error(`The engine did not let this app in (${response.status}).`);
      const { ticket } = (await response.json()) as { ticket: string };
      const url = `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${T3_PROTOCOL}&wsTicket=${encodeURIComponent(ticket)}`;
      const opened = deps.socket(url);
      await new Promise<void>((resolve, reject) => {
        opened.onopen = () => resolve();
        opened.onerror = () => reject(new Error("The engine could not be reached."));
        opened.onclose = () => reject(new Error("The engine could not be reached."));
      });
      opened.onerror = null;
      opened.onclose = () => failAll("The connection to the engine dropped.");
      opened.onmessage = (event) => {
        let frames: unknown;
        try {
          frames = JSON.parse(String(event.data));
        } catch {
          return;
        }
        for (const frame of Array.isArray(frames) ? frames : [frames]) {
          if (frame && typeof frame === "object") receive(opened, frame as Record<string, unknown>);
        }
      };
      ping = setInterval(() => opened.send(JSON.stringify({ _tag: "Ping" })), deps.pingMs ?? 10_000);
      return opened;
    })();
    socket.catch(() => {
      socket = undefined;
    });
    return socket;
  };

  const request = async (
    tag: string,
    payload: unknown,
    onValue?: Pending["onValue"],
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const opened = await open();
    const id = String((nextId += 1));
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { onValue, tail: Promise.resolve(), stopped: false, resolve, reject };
      pending.set(id, entry);
      signal?.addEventListener("abort", () => {
        if (!pending.delete(id)) return;
        entry.stopped = true;
        opened.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
        resolve(undefined);
      });
      opened.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  };

  return {
    call: (tag, payload) => request(tag, payload) as Promise<never>,
    stream: async (tag, payload, onValue, signal) => void (await request(tag, payload, onValue, signal)),
    get: async (path) => {
      const response = await deps.fetch(`${origin}${path}`, { headers });
      if (!response.ok) throw new Error(`The engine answered ${response.status}.`);
      return (await response.json()) as never;
    },
    close: () => {
      void socket?.then((opened) => opened.close()).catch(() => undefined);
      failAll("The connection to the engine was closed.");
    },
  };
}
