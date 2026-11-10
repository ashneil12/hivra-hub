// WP-103: the cheap tier asks a model the person added under Other models, on that model's own key. The key goes from
// the Keychain to the provider inside Rust and never comes back here (src-tauri/src/memory_cheap.rs).
//
// A failure that may pass is a "try again later" for the curator (at most two tries a turn, set by the hook); one that
// will not pass is final. Never a crash and never a retry loop of its own.

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
 * A failure that may pass (no answer in time, a busy provider, a 5xx) is a "try again later": the turn is kept for next
 * time, and the hook allows two tries per turn. A failure that will not pass is final, so it is never asked again:
 * a refusal (a bad key, a 401 or 403, a secret in the prompt, a prompt too long) and a reply that is not the JSON
 * the curator needs. Retrying those only spends the budget.
 */
function unfinished(outcome: CheapOutcome): CuratorAsk {
  if (outcome.ok && typeof outcome.text === "string" && outcome.text.trim() && parseCuratorReply(outcome.text).length > 0) {
    return { ok: true, text: outcome.text };
  }
  if (outcome.ok || outcome.kind === "refused" || outcome.kind === "unreachable") {
    return { ok: false, kind: "refused", reason: outcome.reason || "The model's reply couldn't be read." };
  }
  return { ok: false, kind: "timeout", reason: outcome.reason || "The model didn't answer this time." };
}

/**
 * The curator's ask on the cheap tier. A busy provider or a thrown call comes back as a timeout, which the curator
 * keeps deferred; a refusal or an unreadable reply comes back as refused, which is final.
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
