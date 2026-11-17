// The dev page's way in to a T3 engine (`?t3=<origin>&t3token=<token>`): every provider's chats run through it, so the
// real screens can be walked on T3 before the app itself ships with it. Never part of the installed app's start.
// A dev copy started with an engine (`npm run hub:dev -- --engine <folder>`, scripts/hub-dev-engine.mjs) is told
// where it is by vite instead of by its address.
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
      // The app's resume of a turn a quit cut is not one of those: the engine has that turn and the chat rejoins it.
      if (input.origin === "person" || input.resume) return adapter.sendTurn(input);
      input.onEvent({ type: "session.started" });
      input.onAccepted?.();
      input.onEvent({ type: "message.delta", text: "Right: nothing new since your last message." });
      input.onEvent({ type: "message.completed" });
    },
  };
}

/** The engine a dev copy was started with, as vite was told (`VITE_DROPWAVE_ENGINE`, `VITE_DROPWAVE_ENGINE_TOKEN`). */
export function t3BuiltEngine(env: Record<string, unknown> = import.meta.env): T3Engine | null {
  const origin = typeof env.VITE_DROPWAVE_ENGINE === "string" ? env.VITE_DROPWAVE_ENGINE.replace(/\/+$/, "") : "";
  const token = typeof env.VITE_DROPWAVE_ENGINE_TOKEN === "string" ? env.VITE_DROPWAVE_ENGINE_TOKEN : "";
  return origin && token ? { origin, token } : null;
}

/**
 * One adapter per provider, all on one connection to the engine; none when no engine is named. An engine the page's
 * address names is the dev page's walk, so the app's own turns stay quiet. An engine a dev copy was started with is
 * that copy's engine as the app will have it: every turn runs on it, the app's own included.
 */
export function t3DevPageAdapters(
  page: T3Engine | null = t3Engine(),
  built: T3Engine | null = t3BuiltEngine(),
  connect: (engine: T3Engine) => T3Rpc = (engine) =>
    connectT3(engine.origin, engine.token, {
      fetch: (input, init) => fetch(input, init),
      socket: (url) => new WebSocket(url) as unknown as T3Socket,
    }),
): HarnessAdapter[] {
  const engine = page ?? built;
  if (!engine) return [];
  const rpc = connect(engine);
  return HARNESSES.map((id) => {
    const adapter = createT3Adapter(id, engine, rpc);
    return page ? quietAppTurns(adapter) : adapter;
  });
}
