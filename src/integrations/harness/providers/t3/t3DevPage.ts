// The dev page's way in to a T3 engine (`?t3=<origin>&t3token=<token>`): every provider's chats run through it, so the
// real screens can be walked on T3 before the app itself ships with it. Never part of the installed app's start.
import { HARNESSES } from "../../../../features/sessions/model/session";
import type { HarnessAdapter } from "../../core/registry";
import { createT3Adapter, t3Engine, type T3Engine } from "./t3Adapter";
import { connectT3, type T3Rpc, type T3Socket } from "./t3Rpc";

/**
 * The dev page is for walking what a person types. The app's own background turns (a done check, an inbox count, a
 * catch-up: nothing the person typed) get a quiet line here and never reach the engine: on a replay provider they
 * would use up the script, and on a real model they start runs nobody asked for and the typed message lands in one.
 */
export function quietAppTurns(adapter: HarnessAdapter): HarnessAdapter {
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
  return HARNESSES.map((id) => quietAppTurns(createT3Adapter(id, engine, rpc)));
}
