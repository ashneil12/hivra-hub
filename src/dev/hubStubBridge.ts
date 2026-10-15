// Dev and test only. Stands in for the Rust `hub` plugin by talking to scripts/hub-stub-server.mjs over fetch, with
// the same behaviour: the key is fetched fresh on every call (Rust re-reads the token file), only ash-hub-* actions go
// out, errors are plain `{kind, message}`, and the live feed reconnects with a backoff. Used by
// hub-dev.html (`?stub=<url>`, through browserTauriMock) and by the hub's tests. Never shipped: nothing in the app imports it.
import { toHubError, type HubFeedEvent, type HubFeedHandlers, type HubTransport } from "../features/hub/model/hubTransport";

type Plain = { kind: string; message: string };

export type StubBridge = {
  call(action: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** Start the feed after `after`; resolves to a function that stops it. */
  openFeed(after: number, onEvent: (e: HubFeedEvent) => void, onState: HubFeedHandlers["onState"]): () => void;
};

const plain = (kind: string, message: string): Plain => ({ kind, message });
const ACTION = /^ash-hub-[a-z0-9]+(-[a-z0-9]+)*$/;

export function createStubBridge(baseUrl: string, getToken: () => Promise<string> | string): StubBridge {
  const down = plain("unreachable", "Ash OS isn't running.");

  async function call(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!ACTION.test(action)) throw plain("refused", "The app may only make ash-hub calls.");
    let response: Response;
    try {
      const token = await getToken();
      response = await fetch(`${baseUrl}/api/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
    } catch {
      throw down;
    }
    let body: { ok?: boolean; result?: unknown; error?: string } = {};
    try {
      body = await response.json();
    } catch {
      /* not JSON */
    }
    if (response.status === 401) throw plain("unauthorized", "Ash OS didn't accept the app's key. Restart Ash OS.");
    if (response.status === 403) throw plain("refused", body.error ?? "Ash OS refused the call.");
    if (body.ok === true) return body.result ?? null;
    throw plain("error", body.error ?? `Ash OS answered with an error (${response.status}).`);
  }

  function openFeed(after: number, onEvent: (e: HubFeedEvent) => void, onState: HubFeedHandlers["onState"]): () => void {
    let open = true;
    let cursor = after;
    let controller: AbortController | undefined;
    let attempt = 0;
    const backoff = (n: number) => Math.min(15, 2 ** Math.max(0, n - 1)) * 1000;
    void (async () => {
      while (open) {
        let connected = false;
        try {
          controller = new AbortController();
          const token = await getToken();
          const response = await fetch(`${baseUrl}/api/ash-hub-events?after=${cursor}&stream=1&max_seconds=300`, {
            headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw plain(response.status === 401 ? "unauthorized" : "error", `Ash OS answered with an error (${response.status}).`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let name = "";
          let data = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, nl).replace(/\r$/, "");
              buffer = buffer.slice(nl + 1);
              if (line === "") {
                if (name || data) {
                  const parsed = data ? (JSON.parse(data) as Record<string, unknown>) : {};
                  if (name === "hello") {
                    connected = true;
                    attempt = 0;
                    const latest = Number(parsed.latest ?? cursor);
                    if (parsed.reset) cursor = latest;
                    onState({ connected: true, latest, reset: parsed.reset === true });
                  } else if (name === "hub" && open) {
                    cursor = Math.max(cursor, Number(parsed.seq));
                    onEvent(parsed as unknown as HubFeedEvent);
                  }
                }
                name = "";
                data = "";
              } else if (line.startsWith("event:")) name = line.slice(6).trim();
              else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
            }
          }
        } catch (e) {
          if (!open) return;
          attempt += 1;
          onState({ connected: false, message: toHubError(e).message });
        }
        if (!open) return;
        if (connected) onState({ connected: false, message: "The live feed ended." });
        await new Promise((r) => setTimeout(r, connected ? 250 : backoff(attempt)));
      }
    })();
    return () => {
      open = false;
      controller?.abort();
    };
  }

  return { call, openFeed };
}

/** The bridge as the hub's transport (what the stores use). */
export function bridgeTransport(bridge: StubBridge): HubTransport {
  return {
    async call<T>(action: string, payload?: Record<string, unknown>): Promise<T> {
      try {
        return (await bridge.call(action, payload)) as T;
      } catch (e) {
        throw toHubError(e);
      }
    },
    openFeed: (after, handlers) => bridge.openFeed(after, handlers.onEvent, handlers.onState),
  };
}
