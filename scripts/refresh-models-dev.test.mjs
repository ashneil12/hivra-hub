import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trimModelsDev } from "./refresh-models-dev.mjs";

function model(id, context, tools, extra = {}) {
  return { id, name: id, tool_call: tools, limit: { context, output: 1 }, ...extra };
}

describe("trimModelsDev", () => {
  it("keeps the window and the tool flag, and nothing else", () => {
    const out = trimModelsDev({
      deepseek: { models: { "deepseek-chat": model("deepseek-chat", 128_000, true, { cost: { input: 1 } }) } },
    });
    assert.deepEqual(out["deepseek-chat"], { context: 128_000, tools: true });
    assert.deepEqual(out["deepseek/deepseek-chat"], { context: 128_000, tools: true });
    assert.equal("cost" in (out["deepseek-chat"] ?? {}), false);
  });

  it("drops a window that is not a positive whole number", () => {
    const out = trimModelsDev({
      custom: {
        models: {
          text: model("text", "128000", true),
          zero: model("zero", 0, true),
          negative: model("negative", -5, false),
          fraction: model("fraction", 1.5, true),
          huge: model("huge", 10_000_001, true),
          toolsOnly: { id: "toolsOnly", tool_call: false },
          nothing: { id: "nothing", tool_call: "yes" },
          missing: { name: "no id" },
        },
      },
    });
    assert.deepEqual(out.text, { tools: true });
    assert.equal("context" in out.text, false);
    assert.deepEqual(out.zero, { tools: true });
    assert.deepEqual(out.negative, { tools: false });
    assert.deepEqual(out.fraction, { tools: true });
    assert.deepEqual(out.huge, { tools: true });
    assert.deepEqual(out.toolsOnly, { tools: false });
    assert.equal(out.nothing, undefined);
    assert.equal(out.missing, undefined);
  });

  it("keeps the first window when two providers share an id, and prefers tools", () => {
    const out = trimModelsDev({
      alpha: { models: { shared: model("shared", 100_000, false) } },
      beta: { models: { shared: model("shared", 200_000, true) } },
    });
    assert.deepEqual(out.shared, { context: 100_000, tools: true });
    assert.deepEqual(out["alpha/shared"], { context: 100_000, tools: false });
    assert.deepEqual(out["beta/shared"], { context: 200_000, tools: true });
  });

  it("does not invent a window for an id that did not have one", () => {
    const out = trimModelsDev({
      alpha: { models: { shared: { id: "shared", tool_call: true } } },
      beta: { models: { shared: model("shared", 200_000, false) } },
    });
    assert.deepEqual(out.shared, { tools: true });
    assert.equal("context" in out.shared, false);
    assert.deepEqual(out["beta/shared"], { context: 200_000, tools: false });
  });

  it("stores a provider-qualified id as itself, and an alias beside the model's own id", () => {
    const out = trimModelsDev({
      openrouter: { models: { "x-ai/grok-4": model("x-ai/grok-4", 256_000, true) } },
      local: { models: { alias: { ...model("real-model", 32_000, false), id: "real-model" } } },
    });
    assert.deepEqual(out["x-ai/grok-4"], { context: 256_000, tools: true });
    assert.equal(out["openrouter/x-ai/grok-4"], undefined);
    assert.deepEqual(out["real-model"], { context: 32_000, tools: false });
    assert.deepEqual(out.alias, { context: 32_000, tools: false });
    assert.deepEqual(out["local/real-model"], { context: 32_000, tools: false });
  });

  it("does not let a longer id take a shorter one's window", () => {
    const out = trimModelsDev({
      deepseek: {
        models: {
          deepseek: model("deepseek", 64_000, true),
          "deepseek-chat": model("deepseek-chat", 128_000, true),
        },
      },
    });
    assert.equal(out.deepseek.context, 64_000);
    assert.equal(out["deepseek-chat"].context, 128_000);
  });

  it("reads a providers wrapper, skips junk, and sorts the keys", () => {
    const out = trimModelsDev({
      providers: {
        zeta: { models: { b: model("b", 2, true) } },
        alpha: { models: { a: model("a", 1, false) } },
        note: "not a provider",
        empty: { models: null },
      },
      updated: "yesterday",
    });
    assert.deepEqual(Object.keys(out), ["a", "alpha/a", "b", "zeta/b"]);
    assert.deepEqual(trimModelsDev(null), {});
    assert.deepEqual(trimModelsDev([]), {});
    assert.deepEqual(trimModelsDev({ models: [] }), {});
  });

  it("keeps a unicode id and drops one with a control character", () => {
    const out = trimModelsDev({
      lab: {
        models: {
          "模型": model("模型", 8_000, true),
          "bad\nid": model("bad\nid", 8_000, true),
        },
      },
    });
    assert.deepEqual(out["模型"], { context: 8_000, tools: true });
    assert.equal(out["bad\nid"], undefined);
  });
});
