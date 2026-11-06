// WP-103: the cheap tier asks a model the person added under Other models, on that model's own key. The key goes from
// the Keychain to the provider inside Rust and never comes back here (src-tauri/src/memory_cheap.rs).
//
// Every failure is a "try again later" for the curator, never a crash and never a retry loop of its own: the next turn
// tries again by itself, because a deferred turn is not marked done.

import { invoke } from "@tauri-apps/api/core";
import { listCustomModels, type CustomModel } from "../../sessions/model/customModels";
import { parseCuratorReply, type CuratorAsk } from "./curator";

/** What the Rust side answers (AskOutcome in memory_cheap.rs). */
export type CheapOutcome = { ok: boolean; text: string; kind: string; reason: string };

export type CheapRoute = { provider: string; baseUrl: string; modelId: string; customModelId: string };

/** The setting holds a model's own id, the way Other models writes it (not the picker's `custom:` form). */
export function routeFor(modelId: string | undefined): CheapRoute | undefined {
  if (!modelId) return undefined;
  const model: CustomModel | undefined = listCustomModels().find((have) => have.id === modelId);
  if (!model || typeof model.baseUrl !== "string" || typeof model.modelId !== "string" || !model.modelId.trim()) return undefined;
  return { provider: model.provider, baseUrl: model.baseUrl, modelId: model.modelId, customModelId: model.id };
}

/** Why the cheap tier cannot ask right now, in plain words, or undefined when it can. */
export function cheapProblem(modelId: string | undefined): string | undefined {
  if (!modelId) return "Pick a model under Other models, then pick it here.";
  return routeFor(modelId) ? undefined : "That model is no longer under Other models. Pick another one here.";
}

/**
 * Any failure at all is a "try again later": no key, a timeout, a reply that cannot be read, a 4xx or a 5xx. The turn
 * is kept for next time rather than dropped; the background budget is what stops that becoming a retry storm.
 */
function unfinished(outcome: CheapOutcome): CuratorAsk {
  if (outcome.ok && typeof outcome.text === "string" && outcome.text.trim()) {
    // An empty or unreadable reply is a bad reply, not a quiet turn: leaving it deferred is how it gets tried again.
    if (parseCuratorReply(outcome.text).length > 0) return { ok: true, text: outcome.text };
  }
  return { ok: false, kind: "timeout", reason: outcome.reason || "The model didn't answer this time." };
}

/**
 * The curator's ask on the cheap tier. Anything at all that goes wrong comes back as a timeout, which the curator
 * keeps deferred, so no turn is ever dropped because a provider was busy or a key was not there yet.
 */
export function cheapAsk(modelId: string | undefined, call: (route: CheapRoute, prompt: string) => Promise<CheapOutcome> = realCall): (prompt: string) => Promise<CuratorAsk> {
  return async (prompt) => {
    const route = routeFor(modelId);
    if (!route) return { ok: false, kind: "timeout", reason: cheapProblem(modelId) ?? "No model is picked." };
    try {
      return unfinished(await call(route, prompt));
    } catch {
      return { ok: false, kind: "timeout", reason: "The model didn't answer this time." };
    }
  };
}

export function realCall(route: CheapRoute, prompt: string): Promise<CheapOutcome> {
  return invoke<CheapOutcome>("plugin:hub|memory_cheap_ask", { route, prompt });
}

export type CheapTest = { ok: boolean; message: string };

/** "Test this model": one tiny call, through the same key, with the same plain words Other models uses. */
export async function testCheapModel(
  modelId: string | undefined,
  call: (route: CheapRoute) => Promise<CheapTest> = (route) => invoke<CheapTest>("plugin:hub|memory_cheap_test", { route }),
): Promise<CheapTest> {
  const route = routeFor(modelId);
  if (!route) return { ok: false, message: cheapProblem(modelId) ?? "No model is picked." };
  try {
    const result = await call(route);
    return { ok: !!result?.ok, message: typeof result?.message === "string" && result.message ? result.message : defaultMessage(!!result?.ok) };
  } catch {
    return { ok: false, message: "Couldn't reach the Keychain. Try again." };
  }
}

function defaultMessage(ok: boolean): string {
  return ok ? "Connected, it replied." : "That model didn't answer. Check its key under Other models.";
}
