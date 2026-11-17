// Dropwave on T3 Code (spike, 17 Nov 2026): the same screens, another engine. A chat's turns go to a T3 Code server
// instead of a CLI this app starts itself: one chat is one T3 thread, and what the thread does comes back as the
// harness events every screen already draws (t3Events.ts). Nothing above the adapter changes.
//
// The spike reaches T3 through a small loopback bridge (t3code `scripts/dropwave-engine-bridge.ts`) that speaks T3's
// own RPC; the real build speaks that RPC from here. Only a dev page that names an engine in its address (`?t3`) uses it.
import type { HarnessId } from "../../../../features/sessions/model/session";
import type { HarnessAdapter } from "../../core/registry";
import type { HarnessEvent, SendTurnInput } from "../../core/types";
import { parseT3Lines } from "./t3Events";

const DEFAULT_ENGINE = "http://127.0.0.1:4620";

/** The T3 engine this page was asked to use (`?t3` or `?t3=<url>`), or null. Never set in the installed app. */
export function t3EngineUrl(): string | null {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.search);
  if (!params.has("t3")) return null;
  return params.get("t3") || DEFAULT_ENGINE;
}

export function createT3Adapter(id: HarnessId, engine: string, fetcher: typeof fetch = fetch): HarnessAdapter {
  /** Chat -> T3 thread, as T3 named it on the first turn (kept by the app as the provider session id). */
  const threads = new Map<string, string>();
  const running = new Map<string, AbortController>();
  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    fetcher(`${engine}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

  async function sendTurn(input: SendTurnInput): Promise<void> {
    const abort = new AbortController();
    running.set(input.sessionId, abort);
    const forward = (event: HarnessEvent) => {
      if (event.type === "session.providerBound") threads.set(input.sessionId, event.providerSessionId);
      // The registry tells the chat the turn is ready when the provider accepts it.
      if (event.type === "turn.ready") return input.onAccepted?.();
      input.onEvent(event);
    };
    try {
      const response = await post(
        "/send",
        { sessionId: input.sessionId, text: input.text, origin: input.origin, threadId: threads.get(input.sessionId) },
        abort.signal,
      );
      if (!response.ok || !response.body) throw new Error(`The T3 engine answered ${response.status}.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        const parsed = parseT3Lines(rest + decoder.decode(value, { stream: !done }), done);
        rest = parsed.rest;
        parsed.events.forEach(forward);
        if (done) break;
      }
    } catch (error) {
      if (!abort.signal.aborted)
        input.onEvent({ type: "session.error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (running.get(input.sessionId) === abort) running.delete(input.sessionId);
    }
  }

  async function stop(sessionId: string): Promise<void> {
    running.get(sessionId)?.abort();
    running.delete(sessionId);
    await post("/stop", { sessionId }).catch(() => undefined);
  }

  return {
    id,
    live: true,
    canSteer: false,
    sendTurn,
    steerTurn: async () => {
      throw new Error("A follow-up waits for the reply in this spike.");
    },
    cancelTurn: stop,
    respondApproval: () => undefined,
    stopSession: stop,
    forgetSession: async (sessionId) => {
      await stop(sessionId);
      threads.delete(sessionId);
    },
    bindSession: (sessionId, providerSessionId) => void threads.set(sessionId, providerSessionId),
  };
}
