// The dev page's way in to a T3 engine (`?t3=<origin>&t3token=<token>`): every provider's chats run through it, so the
// real screens can be walked on T3 before the app itself ships with it. Never part of the installed app's start.
import { HARNESSES } from "../../../../features/sessions/model/session";
import type { HarnessAdapter } from "../../core/registry";
import { createT3Adapter, t3Engine, type T3Engine } from "./t3Adapter";
import { connectT3, type T3Rpc, type T3Socket } from "./t3Rpc";

/** T3's replay provider plays a fixed script, one recorded turn per message. */
const REPLAY_PROVIDER = "devReplay";

/**
 * With the replay provider, the app's own background turns (a done check, an inbox count: nothing the person typed)
 * get a quiet line here, so they do not use up the script. A real provider takes every turn.
 */
export function quietForReplay(adapter: HarnessAdapter, engine: T3Engine): HarnessAdapter {
  if (engine.provider !== REPLAY_PROVIDER) return adapter;
  return {
    ...adapter,
    sendTurn: async (input) => {
      if (input.origin === "person") return adapter.sendTurn(input);
      input.onEvent({ type: "session.started" });
      input.onAccepted?.();
      input.onEvent({ type: "message.delta", text: "Right: nothing new since your last message." });
      input.onEvent({ type: "message.completed" });
    },
  };
}

/** One adapter per provider, all on one connection to the engine the page names; none when it names no engine. */
export function t3DevPageAdapters(engine: T3Engine | null = t3Engine()): HarnessAdapter[] {
  if (!engine) return [];
  const rpc: T3Rpc = connectT3(engine.origin, engine.token, {
    fetch: (input, init) => fetch(input, init),
    socket: (url) => new WebSocket(url) as unknown as T3Socket,
  });
  return HARNESSES.map((id) => quietForReplay(createT3Adapter(id, engine, rpc), engine));
}
