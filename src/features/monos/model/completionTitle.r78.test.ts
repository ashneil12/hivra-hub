import { describe, expect, it } from "vitest";
import { completionTitle } from "./monoSessionCompletion";

// r78 (Critiquito on c02 191104-a276): "Session completed: claude · Last week total on the board" named the harness,
// not the model that ran.
describe("a finished worker's row names the model that ran", () => {
  const worker = { title: "claude · Last week total on the board", harness: "claude" as const, model: "claude:deepseek-v4.1-flash" };

  // r90 (Ash): the label comes from the hub's own model record; the bench's Grok routing is named beside it.
  it("on the Grok bench a worker recorded as DeepSeek reads DeepSeek, with the bench's Grok run named", () => {
    expect(completionTitle(worker, { kind: "grok", benchGrok: true })).toBe("DeepSeek V4.1 Flash (bench ran Grok 4.7) · Last week total on the board");
    expect(completionTitle({ ...worker, model: "claude:grok-4.7" }, { kind: "grok", benchGrok: true })).toBe("Grok 4.7 · Last week total on the board");
  });

  it("on the bridge a DeepSeek worker reads DeepSeek, and a Claude alias reads Grok 4.7", () => {
    expect(completionTitle(worker, { kind: "grok", benchGrok: false })).toBe("DeepSeek V4.1 Flash · Last week total on the board");
    expect(completionTitle({ ...worker, model: "sonnet" }, { kind: "grok", benchGrok: false })).toBe("Grok 4.7 · Last week total on the board");
  });

  it("off any bridge it is the chat's own model; no model or no prefix leaves the title alone", () => {
    expect(completionTitle({ ...worker, model: "claude-sonnet-5" }, { benchGrok: false })).toBe("claude-sonnet-5 · Last week total on the board");
    expect(completionTitle({ ...worker, model: undefined }, { benchGrok: false })).toBe(worker.title);
    expect(completionTitle({ ...worker, title: "Docs pass" }, { kind: "grok", benchGrok: true })).toBe("Docs pass");
  });
});
