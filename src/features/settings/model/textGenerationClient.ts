// WP-129: ask the saved text model for one short reply. No tools and no repo writes.
// The key stays in Rust (text_generation_ask). A timeout is something to try again, not a reason to forget the setting.

import { invoke } from "@tauri-apps/api/core";
import { hasSecretText } from "../../portable/model/secrets";
import { admitSpendTurn, noteUnpricedTurn, spendGateActive, type TurnOrigin } from "../../usage/model/spendGate";
import { readTextGeneration, type TextGenerationSetting } from "./textGeneration";

/** Same ceiling as the Rust call, in characters. */
export const TEXT_PROMPT_LIMIT = 60_000;
export const TEXT_REPLY_LIMIT = 8_000;

const KEY_ID = /^[A-Za-z0-9._-]{1,120}$/;
const TRY_AGAIN = "The model didn't answer this time. It can be tried again.";

/** A model saved under Other models. Only its id is sent, so Rust can read the key. */
export type SavedTextModel = {
  id: string;
  provider: string;
  baseUrl: string;
  modelId: string;
};

/** What a port is allowed to see. There is no path and no tool list. */
export type TextGenerationRequest = {
  provider: string;
  model: string;
  baseUrl: string;
  customModelId: string;
  prompt: string;
};

export type TextGenerationPort = {
  complete(request: TextGenerationRequest, signal?: AbortSignal): Promise<string>;
};

export class TextGenerationError extends Error {
  readonly kind: "timeout" | "refused" | "empty";

  constructor(message: string, kind: "timeout" | "refused" | "empty") {
    super(message);
    this.name = "TextGenerationError";
    this.kind = kind;
  }
}

function stripSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function plainReason(reason: unknown, fallback: string): string {
  if (typeof reason !== "string") return fallback;
  const text = reason.trim();
  if (!text || text.length > 400 || hasSecretText(text)) return fallback;
  return text;
}

function capReply(text: string): string {
  const chars = [...text];
  if (chars.length <= TEXT_REPLY_LIMIT) return text;
  return chars.slice(0, TEXT_REPLY_LIMIT).join("");
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The request was aborted.", "AbortError");
}

/**
 * The Other-models id whose provider, model and address all match.
 * A different address is not a match: that key must not be sent to this host. No match is null.
 */
export function textModelKeyId(setting: TextGenerationSetting, models: readonly SavedTextModel[]): string | null {
  const clean = readTextGeneration(setting);
  if (!clean || !Array.isArray(models)) return null;
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    if (typeof model.id !== "string" || !KEY_ID.test(model.id)) continue;
    if (model.provider !== clean.provider) continue;
    if (typeof model.modelId !== "string" || model.modelId.trim() !== clean.model) continue;
    if (typeof model.baseUrl !== "string" || stripSlash(model.baseUrl) !== clean.baseUrl) continue;
    return model.id;
  }
  return null;
}

/** What the Rust command answered. A key in the text or the reason is dropped. */
export function textFromOutcome(outcome: unknown): string {
  if (!outcome || typeof outcome !== "object") {
    throw new TextGenerationError(TRY_AGAIN, "timeout");
  }
  const row = outcome as Record<string, unknown>;
  const kind = typeof row.kind === "string" ? row.kind : "";
  const text = typeof row.text === "string" ? row.text : "";
  if (row.ok === true && text.trim() && kind !== "empty") {
    if (hasSecretText(text)) throw new TextGenerationError(TRY_AGAIN, "timeout");
    return capReply(text);
  }
  if (kind === "refused") {
    throw new TextGenerationError(plainReason(row.reason, "That model turned this down."), "refused");
  }
  if (kind === "empty" || row.ok === true) {
    throw new TextGenerationError(plainReason(row.reason, "The model sent nothing back."), "empty");
  }
  return never(plainReason(row.reason, TRY_AGAIN));
}

function never(reason: string): never {
  throw new TextGenerationError(reason, "timeout");
}

function raceAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(abortError(signal));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The real port. It names no path, so there is nothing for it to write. */
export const realTextGenerationPort: TextGenerationPort = {
  async complete(request, signal) {
    signal?.throwIfAborted();
    const route = {
      provider: request.provider,
      baseUrl: request.baseUrl,
      modelId: request.model,
      customModelId: request.customModelId,
    };
    // WP-129: Rust keeps this route and refuses an ask that does not match it.
    await raceAbort(invoke("plugin:hub|text_generation_remember", { route }), signal);
    signal?.throwIfAborted();
    const outcome = await raceAbort(
      invoke<unknown>("plugin:hub|text_generation_ask", {
        route,
        prompt: request.prompt,
      }),
      signal,
    );
    return textFromOutcome(outcome);
  },
};

let portOverride: TextGenerationPort | null = null;

/** The port the generators use. Tests can stand in for it. */
export function textGenerationPort(): TextGenerationPort {
  return portOverride ?? realTextGenerationPort;
}

export function useTextGenerationPort(port: TextGenerationPort | null): void {
  portOverride = port;
}

/**
 * One short reply, or a TextGenerationError. `timeout` means try again (the setting stays).
 * `refused` means this ask will not be sent. `empty` means the reply was not usable text.
 * An aborted signal is not turned into either: it rejects as AbortError, and a late reply is dropped.
 */
let shortTextSeq = 0;

export async function askShortText(input: {
  setting: TextGenerationSetting;
  prompt: string;
  models: readonly SavedTextModel[];
  port: TextGenerationPort;
  signal?: AbortSignal;
  /** Who asked: a commit message Ash asks for is his turn (warned, not refused); otherwise automated (round 6). */
  origin?: TurnOrigin;
}): Promise<string> {
  const setting = readTextGeneration(input.setting);
  if (!setting) throw new TextGenerationError("No text model is set.", "refused");
  const prompt = input.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new TextGenerationError("There was nothing to send.", "refused");
  }
  if (hasSecretText(prompt)) {
    throw new TextGenerationError("That text contained a secret, so it was not sent.", "refused");
  }
  if ([...prompt].length > TEXT_PROMPT_LIMIT) {
    throw new TextGenerationError("That text is too long to send.", "refused");
  }
  const keyId = textModelKeyId(setting, input.models);
  if (keyId == null && setting.provider !== "ollama") {
    throw new TextGenerationError("No key is saved for that model. Add it under Other models.", "refused");
  }
  input.signal?.throwIfAborted();
  // The saved text model is a billed call: it passes the spend gate, and what it ran is noted as unpriced.
  const sessionId = `short-text-${(shortTextSeq += 1)}`;
  if (spendGateActive()) {
    const admitted = await admitSpendTurn({ sessionId, cwd: "", harness: "claude", model: keyId ?? undefined, origin: input.origin ?? "automated" });
    if (!admitted.ok) throw new TextGenerationError(admitted.reason, "refused");
  }
  const request: TextGenerationRequest = {
    provider: setting.provider,
    model: setting.model,
    baseUrl: setting.baseUrl,
    customModelId: keyId ?? "",
    prompt,
  };
  let text: string;
  try {
    text = await input.port.complete(request, input.signal);
    noteUnpricedTurn({ sessionId, cwd: "" });
  } catch (error) {
    if (isAbort(error) || error instanceof TextGenerationError) throw error;
    const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    throw new TextGenerationError(plainReason(reason, TRY_AGAIN), "timeout");
  }
  input.signal?.throwIfAborted();
  if (typeof text !== "string" || hasSecretText(text)) {
    throw new TextGenerationError(TRY_AGAIN, "timeout");
  }
  if (!text.trim()) throw new TextGenerationError("The model sent nothing back.", "empty");
  return capReply(text);
}
