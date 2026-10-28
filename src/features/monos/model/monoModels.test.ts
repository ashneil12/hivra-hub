// Ash (27 Oct): every Mono and Lead names Grok 4.7; a Mono on a Claude name (or a Lead with none) moves over once,
// through the roster's own save, and a model Ash chose stays.
import { describe, expect, it } from "vitest";
import type { Mono } from "./mono";
import { migrateMonoModels, monoChatModelFix, monoModelFix } from "./monoModels";

const mono = (id: string, extra: Partial<Mono> = {}) => ({ id, name: id, ...extra }) as Mono;

describe("monoModelFix", () => {
  it("moves a Claude Code Mono on a Claude name, or none, to Grok 4.7", () => {
    const grok = { engine: "claude", engineModel: "claude:grok-4.7" };
    expect(monoModelFix(mono("alfred", { engine: "claude" }))).toEqual(grok);
    expect(monoModelFix(mono("checker", { engine: "claude", engineModel: "claude:haiku" }))).toEqual(grok);
    expect(monoModelFix(mono("frank", { engine: "claude", engineModel: "claude:sonnet-5" }))).toEqual(grok);
    expect(monoModelFix(mono("hub-lead"))).toEqual(grok);
  });

  it("leaves a model Ash chose, another engine, and his own Monos without an engine", () => {
    expect(monoModelFix(mono("a", { engine: "claude", engineModel: "claude:grok-4.7" }))).toBeUndefined();
    expect(monoModelFix(mono("b", { engine: "claude", engineModel: "claude:deepseek-v4.1-flash" }))).toBeUndefined();
    expect(monoModelFix(mono("c", { engine: "claude", engineModel: "custom:ds-1" }))).toBeUndefined();
    expect(monoModelFix(mono("d", { engine: "codex", engineModel: "codex:gpt-5.6" }))).toBeUndefined();
    expect(monoModelFix(mono("ash-own"))).toBeUndefined();
  });
});

describe("migrateMonoModels", () => {
  it("saves each move through the roster once, and a second run changes nothing", () => {
    let roster = [
      mono("alfred", { engine: "claude" }),
      mono("checker", { engine: "claude", engineModel: "claude:haiku" }),
      mono("mine", { engine: "claude", engineModel: "custom:ds-1" }),
    ];
    const update = (id: string, change: (m: Mono) => Mono) => {
      roster = roster.map((m) => (m.id === id ? change(m) : m));
      return roster.find((m) => m.id === id);
    };
    expect(migrateMonoModels({ list: () => roster, update: update as never })).toEqual(["alfred", "checker"]);
    expect(roster.map((m) => m.engineModel)).toEqual(["claude:grok-4.7", "claude:grok-4.7", "custom:ds-1"]);
    expect(migrateMonoModels({ list: () => roster, update: update as never })).toEqual([]);
  });
});

describe("monoChatModelFix", () => {
  const alfred = { engine: "claude" as const, engineModel: "claude:grok-4.7" };
  it("moves a Mono's chat still on a Claude name", () => {
    expect(monoChatModelFix(alfred, { harness: "claude", model: "claude:sonnet-5" })).toBe("claude:grok-4.7");
    expect(monoChatModelFix(alfred, { harness: "claude" })).toBe("claude:grok-4.7");
  });
  it("leaves a chat already there, one Ash moved, or one on another engine", () => {
    expect(monoChatModelFix(alfred, { harness: "claude", model: "claude:grok-4.7" })).toBeUndefined();
    expect(monoChatModelFix(alfred, { harness: "claude", model: "custom:ds-1" })).toBeUndefined();
    expect(monoChatModelFix(alfred, { harness: "codex", model: "codex:gpt-5.6" })).toBeUndefined();
    expect(monoChatModelFix({ engine: "claude" }, { harness: "claude", model: "claude:sonnet-5" })).toBeUndefined();
  });
});
