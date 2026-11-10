import { describe, expect, it } from "vitest";
import type { CrewRule } from "./rules";
import type { Presence } from "./resolve";
import { crewRowsWithReason, pickMate, type MonoCandidate } from "./pick";

const signed = (...clis: string[]): Presence[] => clis.map((cli) => ({ cli, installed: true, signedIn: true }));

const builder: CrewRule = { labels: ["builder"], paths: [], cli: "codex", model: "gpt-codex", effort: "high", source: "person" };

const ada: MonoCandidate = { id: "ada", name: "Ada", role: "reviewer" };

describe("first mate pick", () => {
  it("a role rule prefers that CLI, and the reason is not empty", () => {
    const pick = pickMate({ labels: ["builder"], rules: [builder], present: signed("claude", "codex") });
    expect(pick.ok).toBe(true);
    expect(pick.cli).toBe("codex");
    expect(pick.monoId).toBeNull();
    expect(pick.model).toBe("gpt-codex");
    expect(pick.effort).toBe("high");
    expect(pick.reason).toBe("Builder role prefers Codex.");
  });

  it("a Mono that fits the role is chosen, and the lead Mono is not", () => {
    const pick = pickMate({
      labels: ["reviewer"],
      present: signed("claude"),
      monos: [ada, { id: "lead", name: "Lead", role: "reviewer" }],
      leadMonoId: "lead",
    });
    expect(pick.monoId).toBe("ada");
    expect(pick.cli).toBeNull();
    expect(pick.reason).toBe("Ada fits the reviewer role.");
  });

  it("refuses another Mono at depth 2 and at depth 3", () => {
    const two = pickMate({ labels: ["reviewer"], present: [], monos: [ada], depth: 2 });
    expect(two.ok).toBe(false);
    expect(two.monoId).toBeNull();
    expect(two.reason).toBe("This chat is already two Monos deep, so another Mono was refused.");
    const three = pickMate({
      labels: ["reviewer"],
      present: signed("claude"),
      monos: [ada],
      depth: 3,
      override: { monoId: "ada" },
    });
    expect(three.ok).toBe(false);
    expect(three.reason).toBe("This chat is already three Monos deep, so another Mono was refused.");
  });

  it("with the lock off, an override still beats the role", () => {
    const pick = pickMate({
      labels: ["builder"],
      rules: [builder],
      present: signed("claude", "codex", "grok"),
      override: { cli: "grok" },
      policy: { lockDefault: false, neverUse: [], fallback: [] },
    });
    expect(pick.cli).toBe("grok");
    expect(pick.reason).toBe("This task asks for Grok.");
  });

  it("the lock drops the override, and the person's brief still wins", () => {
    const locked = pickMate({
      labels: ["builder"],
      rules: [builder],
      present: signed("claude", "codex", "grok"),
      override: { cli: "grok" },
      policy: { lockDefault: true, neverUse: [], fallback: [] },
    });
    expect(locked.cli).toBe("codex");
    expect(locked.reason).toBe("Always use my default is on, so this override was not applied. Builder role prefers Codex.");
    const brief = pickMate({
      labels: ["builder"],
      rules: [builder],
      present: signed("claude", "codex", "cursor"),
      override: { cli: "grok" },
      brief: { cli: "cursor" },
      policy: { lockDefault: true, neverUse: [], fallback: [] },
    });
    expect(brief.cli).toBe("cursor");
    expect(brief.reason).toContain("This task asks for Cursor.");
    expect(brief.reason.startsWith("Always use my default is on")).toBe(true);
  });

  it("does not pick a provider that is not signed in", () => {
    const pick = pickMate({
      present: [
        { cli: "grok", installed: true, signedIn: false },
        { cli: "claude", installed: true, signedIn: true },
      ],
      catalog: { grok: [{ id: "grok-4", efforts: ["low"] }] },
    });
    expect(pick.cli).toBe("claude");
    expect(pick.reason).toBe("Nothing else is set, so this uses Claude Code.");
  });

  it("a paused role CLI is skipped, and the reason names the quota", () => {
    const pick = pickMate({
      labels: ["builder"],
      rules: [builder],
      present: signed("codex", "claude"),
      pausedClis: ["codex"],
    });
    expect(pick.cli).toBe("claude");
    expect(pick.reason).toBe("Codex is at its quota, so this uses Claude Code.");
  });

  it("follows the person's fallback order, then the signed-in default", () => {
    const ordered = pickMate({
      present: signed("claude", "grok", "codex"),
      policy: { lockDefault: false, neverUse: [], fallback: ["grok", "codex"] },
    });
    expect(ordered.cli).toBe("grok");
    expect(ordered.reason).toBe("Fallback order puts Grok next.");
    const first = pickMate({ present: signed("cursor", "codex") });
    expect(first.cli).toBe("cursor");
    expect(first.reason).toBe("Nothing else is set, so this uses Cursor.");
  });

  it("a banned role CLI is skipped, and its model is not kept", () => {
    const pick = pickMate({
      labels: ["builder"],
      rules: [builder],
      present: signed("codex", "claude"),
      policy: { lockDefault: false, neverUse: ["codex"], fallback: [] },
    });
    expect(pick.cli).toBe("claude");
    expect(pick.model).toBeNull();
    expect(pick.effort).toBeNull();
    expect(pick.reason).toBe("Codex is on Never use, so it was skipped. Nothing else is set, so this uses Claude Code.");
  });

  it("a worker already at the cap is not used while another is free", () => {
    const pick = pickMate({
      present: signed("claude", "codex"),
      atCap: ["claude"],
    });
    expect(pick.cli).toBe("codex");
  });

  it("shows the reason on the crew row, and hides a secret", () => {
    const row = { id: "w1", project: "/work/proj", title: "Build", createdAt: 1, updatedAt: 2 };
    const shown = crewRowsWithReason("/work/proj", row, { reason: "Builder role prefers Codex." }, 10);
    expect(shown[0]?.notice).toBe("Builder role prefers Codex.");
    const hidden = crewRowsWithReason("/work/proj", row, { reason: "The key is sk-live-secret" }, 10);
    expect(hidden[0]?.notice).toBeNull();
  });
});
