// @vitest-environment happy-dom
// WP-103: the cheap tier. Any trouble is a deferral, never a crash, and the model is read from Other models each time.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cheapAsk, cheapProblem, routeFor, testCheapModel, type CheapOutcome, type CheapRoute } from "./cheapAsk";

const MODELS = [
  { id: "deepseek-def456", name: "DeepSeek chat", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
  { id: "ollama-ghi789", name: "Llama on this Mac", provider: "ollama", baseUrl: "http://localhost:11434", modelId: "llama3.2" },
];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:custom-models", JSON.stringify(MODELS));
});

const call = (outcome: CheapOutcome) => async () => outcome;

describe("the cheap tier's ask", () => {
  it("reads the model from Other models, with its own address and id", async () => {
    const seen: Array<{ route: CheapRoute; prompt: string }> = [];
    const ask = cheapAsk("deepseek-def456", async (route, prompt) => {
      seen.push({ route, prompt });
      return { ok: true, text: '{"kind":"none"}', kind: "ok", reason: "" };
    });
    expect(await ask("the prompt")).toEqual({ ok: true, text: '{"kind":"none"}' });
    expect(seen).toEqual([
      {
        route: { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat", customModelId: "deepseek-def456" },
        prompt: "the prompt",
      },
    ]);
    expect(routeFor("ollama-ghi789")).toMatchObject({ provider: "ollama", baseUrl: "http://localhost:11434" });
    expect(routeFor(undefined)).toBeUndefined();
    expect(routeFor("xai-gone")).toBeUndefined();
  });

  it("defers on a timeout, an unreachable provider, a bad reply, an error or a key that is not there", async () => {
    for (const outcome of [
      { ok: false, text: "", kind: "timeout", reason: "slow" },
      { ok: false, text: "", kind: "retryable", reason: "busy" },
      { ok: false, text: "", kind: "unreachable", reason: "shape" },
      { ok: false, text: "", kind: "refused", reason: "No key is saved for that model." },
    ]) {
      const answer = await cheapAsk("deepseek-def456", call(outcome))("p");
      expect(answer.ok).toBe(false);
    }
    // A busy provider or no answer in time stays deferred; a refusal or an unreadable reply is final.
    const later: CheapOutcome[] = [
      { ok: false, text: "", kind: "retryable", reason: "busy" },
      { ok: false, text: "", kind: "timeout", reason: "slow" },
    ];
    for (const outcome of later) {
      const answer = await cheapAsk("deepseek-def456", call(outcome))("p");
      expect(answer.ok ? "ok" : answer.kind, outcome.kind).toBe("timeout");
    }
    const final: CheapOutcome[] = [
      { ok: false, text: "", kind: "unreachable", reason: "shape" },
      { ok: false, text: "", kind: "refused", reason: "That model turned this down." },
      { ok: false, text: "", kind: "refused", reason: "No key is saved for that model." },
      { ok: true, text: "", kind: "ok", reason: "" },
      { ok: true, text: "I think they like small commits.", kind: "ok", reason: "" },
    ];
    for (const outcome of final) {
      const answer = await cheapAsk("deepseek-def456", call(outcome))("p");
      expect(answer.ok ? "ok" : answer.kind, outcome.kind).toBe("refused");
    }
  });

  it("never throws, even when the call itself does", async () => {
    const answer = await cheapAsk("deepseek-def456", async () => {
      throw new Error("The Keychain said no");
    })("p");
    expect(answer).toMatchObject({ ok: false, kind: "timeout" });
    expect(JSON.stringify(answer)).not.toContain("Keychain said no");
  });

  it("defers when no model is picked, or the picked one is gone, and says why in plain words", async () => {
    for (const id of [undefined, "", "xai-gone"]) {
      const answer = await cheapAsk(id, async () => ({ ok: true, text: "unused", kind: "ok", reason: "" }))("p");
      expect(answer).toMatchObject({ ok: false, kind: "timeout" });
    }
    expect(cheapProblem(undefined)).toBe("Pick a model under Other models, then pick it here.");
    expect(cheapProblem("xai-gone")).toBe("That model is no longer under Other models. Pick another one here.");
    expect(cheapProblem("deepseek-def456")).toBeUndefined();
  });

  it("tests the picked model in plain words, and never throws", async () => {
    const seen: CheapRoute[] = [];
    const ok = await testCheapModel("deepseek-def456", async (route) => {
      seen.push(route);
      return { ok: true, message: "Connected, DeepSeek chat replied" };
    });
    expect(ok).toEqual({ ok: true, message: "Connected, DeepSeek chat replied" });
    expect(seen[0]).toMatchObject({ customModelId: "deepseek-def456", modelId: "deepseek-chat" });
    const failed = await testCheapModel("deepseek-def456", async () => {
      throw new Error("Keychain");
    });
    expect(failed).toEqual({ ok: false, message: "Couldn't reach the Keychain. Try again." });
    const empty = await testCheapModel("deepseek-def456", async () => ({ ok: false, message: "" }));
    expect(empty.ok).toBe(false);
    expect(empty.message.length).toBeGreaterThan(0);
    expect(await testCheapModel("xai-gone")).toEqual({ ok: false, message: "That model is no longer under Other models. Pick another one here." });
    expect(await testCheapModel(undefined)).toEqual({ ok: false, message: "Pick a model under Other models, then pick it here." });
  });
});
