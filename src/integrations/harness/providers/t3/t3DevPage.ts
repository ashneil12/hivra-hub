// The dev page's way in to a T3 engine (`?t3=<origin>&t3token=<token>`): every provider's chats run through it, so the
// real screens can be walked on T3 before the app itself ships with it. Never part of the installed app's start.
// A dev copy started with an engine (`npm run hub:dev -- --engine <folder>`, scripts/hub-dev-engine.mjs) is told
// where it is by vite instead of by its address.
import { HARNESSES, HARNESS_TITLE } from "../../../../features/sessions/model/session";
import { probeHarnessAvailability, setHarnessAvailabilitySource } from "../../core/availability";
import { setHarnessEngineTurnOn } from "../../core/availabilityState";
import type { HarnessAdapter } from "../../core/registry";
import { createT3Adapter, t3Engine, type T3Engine } from "./t3Adapter";
import { t3Availability, t3Provider, t3TurnOn, type T3Provider } from "./t3Models";
import { ENGINE_BRIEFING_TAG } from "../../../../features/crew/model/engineMates";
import { ENGINE_ANSWER_TAG } from "../../../../features/crew/model/engineAnswer";
import { setT3ThreadChats } from "./t3Links";
import { createT3Watch } from "./t3Outside";
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
      // The app's resume of a turn a quit cut is not one of those, nor is its follow of a turn the engine began: the
      // engine has that turn and nothing is sent. Its briefing of a first mate (crew/model/engineMates.ts) is part of
      // what the walk shows: without it a first mate the Chief of Staff writes to does not know who it is. So is a
      // first mate's answer passed back to the chat that handed it the job (crew/model/engineAnswer.ts).
      if (
        input.origin === "person" ||
        input.resume ||
        input.follow ||
        input.text.includes(ENGINE_BRIEFING_TAG) ||
        input.text.includes(ENGINE_ANSWER_TAG)
      )
        return adapter.sendTurn(input);
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
 * True when this copy's chats run on an engine (a dev page that names one, a dev copy started with one). What reaches
 * an agent through Claude Code's own launch in the app (the note on its system prompt, the app's delegate tool) does
 * not reach one the engine starts.
 */
export function runsOnEngine(): boolean {
  return (import.meta.env.DEV || import.meta.env.MODE === "mockup") && !!(t3Engine() ?? t3BuiltEngine());
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
  // One watch for the engine: a chat's conversation is the same whichever provider's adapter runs its turns.
  const watch = createT3Watch(rpc);
  setT3ThreadChats(watch.chatOf);
  // The engine starts each tool, so it says which ones can run (and why one cannot), not this app's look on disk.
  type Config = { providers?: T3Provider[]; settings?: { providerInstances?: Record<string, Record<string, unknown>> } };
  setHarnessAvailabilitySource(() =>
    rpc
      .call<Config>("server.getConfig", {})
      .then((config) =>
        Array.isArray(config?.providers)
          ? t3Availability(HARNESSES, config.providers, (harness) => HARNESS_TITLE[harness], engine.provider)
          : undefined,
      ),
  );
  setHarnessEngineTurnOn(async (harness) => {
    const config = await rpc.call<Config>("server.getConfig", {});
    const provider = t3Provider(harness, config?.providers ?? [], engine.provider);
    if (!provider) throw new Error(`The engine has no provider set up for ${HARNESS_TITLE[harness]}.`);
    await rpc.call("server.updateSettings", t3TurnOn(provider, config?.settings?.providerInstances?.[provider.instanceId]));
    await probeHarnessAvailability({ force: true });
  });
  return HARNESSES.map((id) => {
    const adapter = createT3Adapter(id, engine, rpc, watch);
    return page ? quietAppTurns(adapter) : adapter;
  });
}
