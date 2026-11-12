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

  it("never offers a Claude subscription outside Claude Code (Anthropic's terms)", () => {
    for (const harness of HARNESSES) {
      if (harness === "claude") continue;
      expect(modelConnection(harness, "claudeLogin").status, harness).toBe("blocked");
      expect(mayOffer(harness, "claudeLogin"), harness).toBe(false);
    }
    expect(modelConnection("claude", "claudeLogin")).toMatchObject({ status: "works", via: "own" });
  });

  it("Oh My Pi with a Claude login is blocked, with an Anthropic key it is set up in the agent", () => {
    expect(modelConnection("omp", "claudeLogin").status).toBe("blocked");
    expect(modelConnection("omp", "claudeLogin").note).toMatch(/Anthropic API key/);
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

  it("only Claude Code has app-made connections today", () => {
    for (const harness of HARNESSES) {
      if (harness === "claude") continue;
      for (const { id } of MODEL_SOURCES) expect(isExtraConnection(harness, id), `${harness} x ${id}`).toBe(false);
    }
  });
});
