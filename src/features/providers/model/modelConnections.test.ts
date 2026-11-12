import { describe, expect, it } from "vitest";
import { HARNESSES } from "../../sessions/model/session";
import {
  MODEL_SOURCES,
  isExtraConnection,
  mayOffer,
  modelConnection,
  workingSources,
} from "./modelConnections";

describe("modelConnections", () => {
  it("has a rule for every agent and every source", () => {
    for (const harness of HARNESSES) {
      for (const { id } of MODEL_SOURCES) {
        const c = modelConnection(harness, id);
        expect(c.note.length, `${harness} x ${id}`).toBeGreaterThan(0);
        expect(c.via !== undefined).toBe(c.status === "works");
      }
    }
  });

  it("never offers a Claude subscription except through Claude Code itself", () => {
    expect(modelConnection("claude", "claudeLogin")).toMatchObject({ status: "works", via: "own" });
    for (const harness of ["pi", "omp"] as const) {
      expect(modelConnection(harness, "claudeLogin")).toMatchObject({ status: "works", via: "app" });
      expect(modelConnection(harness, "claudeLogin").note).toMatch(/claude -p/);
    }
    expect(modelConnection("opencode", "claudeLogin").status).toBe("agentSetup");
    for (const harness of ["codex", "hermes", "grok", "cursor", "fx", "antigravity", "devin"] as const) {
      expect(modelConnection(harness, "claudeLogin").status, harness).toBe("no");
    }
  });

  it("nothing is blocked today", () => {
    for (const harness of HARNESSES) {
      for (const { id } of MODEL_SOURCES) expect(modelConnection(harness, id).status).not.toBe("blocked");
    }
  });

  it("Oh My Pi can also use an Anthropic key set up in the agent", () => {
    expect(modelConnection("omp", "anthropicKey").status).toBe("agentSetup");
    expect(mayOffer("omp", "anthropicKey")).toBe(true);
  });

  it("marks the model router's routes for Claude Code as extra connections", () => {
    for (const source of ["xai", "openrouter", "deepseek", "ollama", "custom"] as const) {
      expect(isExtraConnection("claude", source), source).toBe(true);
    }
    expect(isExtraConnection("claude", "claudeLogin")).toBe(false);
    expect(workingSources("claude")).toEqual(["claudeLogin", "xai", "openrouter", "deepseek", "ollama", "custom"]);
  });

  it("Pi and Oh My Pi get the saved models through the app's router", () => {
    for (const harness of ["pi", "omp"] as const) {
      for (const source of ["xai", "openrouter", "deepseek", "ollama", "custom"] as const) {
        expect(isExtraConnection(harness, source), `${harness} x ${source}`).toBe(true);
      }
      expect(isExtraConnection(harness, "anthropicKey")).toBe(false);
      expect(workingSources(harness)).toEqual(["claudeLogin", "xai", "openrouter", "deepseek", "ollama", "custom"]);
    }
  });

  it("Codex gets the saved models that speak OpenAI Responses", () => {
    for (const source of ["xai", "openrouter", "ollama", "custom"] as const) {
      expect(isExtraConnection("codex", source), source).toBe(true);
    }
    expect(modelConnection("codex", "deepseek").status).toBe("no");
  });

  it("only Claude Code, Pi, Oh My Pi and Codex have app-made connections today", () => {
    for (const harness of HARNESSES) {
      if (harness === "claude" || harness === "pi" || harness === "omp" || harness === "codex") continue;
      for (const { id } of MODEL_SOURCES) expect(isExtraConnection(harness, id), `${harness} x ${id}`).toBe(false);
    }
  });
});
