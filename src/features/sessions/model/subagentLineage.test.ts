import { describe, expect, it } from "vitest";
import {
  lineageForThread,
  lineageTally,
  NOT_REPORTED_BY_CLI,
  type Lineage,
  type LineageChild,
} from "./subagentLineage";

/**
 * The list on a parent thread is read off the agent rows the session holds. The frames that make those rows are
 * checked where they enter the app: claudeFixtureReplay.test.ts and claudeLive.test.ts for Claude, codexLive.test.ts
 * for Codex. This file checks what the list makes of a row.
 */

function agentBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    role: "tool",
    text: "Explore the auth module",
    tool: {
      callId: "toolu_agent",
      kind: "agent",
      title: "Explore the auth module",
      status: "completed",
      detail: "Auth lives in src/auth.",
    },
    agentRun: {
      name: "Explore the auth module",
      agentType: "explore",
      model: "claude-haiku-5",
      steps: [],
    },
    ...overrides,
  };
}

function children(lineage: Lineage | null): LineageChild[] {
  if (!lineage?.reported) throw new Error("expected a reported lineage");
  return lineage.children;
}

function only(lineage: Lineage | null): LineageChild {
  const rows = children(lineage);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("a child read off its agent row", () => {
  it("has a name, role, model and the report it handed back", () => {
    expect(only(lineageForThread("claude", [agentBlock()]))).toEqual({
      id: "toolu_agent",
      name: "Explore the auth module",
      role: "explore",
      model: "claude-haiku-5",
      status: "done",
      result: "Auth lives in src/auth.",
      error: null,
    });
  });

  it("is working while the call is open, with no result yet", () => {
    const row = only(
      lineageForThread("codex", [
        agentBlock({
          tool: { callId: "c1", kind: "agent", title: "Review", status: "in_progress", detail: "partial" },
        }),
      ]),
    );
    expect(row).toMatchObject({ status: "running", result: null, error: null });
  });

  it("keeps a failure as an error, not a result", () => {
    const row = only(
      lineageForThread("claude", [
        agentBlock({
          tool: { callId: "toolu_agent", kind: "agent", title: "Review", status: "failed", detail: "API error." },
        }),
      ]),
    );
    expect(row).toMatchObject({ status: "failed", error: "API error.", result: null });
  });

  it.each(["killed", "stopped", "cancelled"])("reads %s as stopped", (status) => {
    const row = only(
      lineageForThread("claude", [
        agentBlock({ tool: { callId: "toolu_agent", kind: "agent", title: "Review", status, detail: "x" } }),
      ]),
    );
    expect(row).toMatchObject({ status: "cancelled", result: null, error: null });
  });

  it("falls back to the call's own title, then to Subagent", () => {
    expect(
      only(
        lineageForThread("claude", [
          agentBlock({
            agentRun: undefined,
            tool: { callId: "t", kind: "task", title: "Check the migration", status: "completed" },
          }),
        ]),
      ).name,
    ).toBe("Check the migration");
    expect(
      only(
        lineageForThread("claude", [
          { id: "b9", role: "tool", text: "", tool: { kind: "subagent", status: "completed" } },
        ]),
      ),
    ).toMatchObject({ id: "b9", name: "Subagent", role: null, model: null });
  });

  it("hides an automatic model and keeps a unicode name on one line with no em dash", () => {
    const row = only(
      lineageForThread("claude", [
        agentBlock({
          agentRun: { name: "Prüfe die Anmeldung — schnell\nsecond line", model: "inherit", steps: [] },
        }),
      ]),
    );
    expect(row.name).toBe("Prüfe die Anmeldung, schnell");
    expect(row.model).toBeNull();
  });

  it("clips a very long report", () => {
    const row = only(
      lineageForThread("claude", [
        agentBlock({ tool: { callId: "t", kind: "agent", title: "x", status: "completed", detail: "a".repeat(5000) } }),
      ]),
    );
    expect(row.result!.length).toBeLessThanOrEqual(2000);
  });
});

describe("which rows are children", () => {
  it("does not turn a workflow or a plain tool into one, and skips junk", () => {
    expect(
      lineageForThread("claude", [
        {
          id: "w",
          role: "tool",
          text: "Fan out",
          tool: { kind: "workflow", title: "Fan out", status: "completed" },
          workflowRun: { agents: [] },
        },
        { id: "r", role: "tool", text: "Read notes", tool: { kind: "read", title: "Read notes", status: "completed" } },
        { id: "m", role: "assistant", text: "Hello" },
        null,
        { id: "bad", role: "tool" },
      ]),
    ).toBeNull();
  });

  it("is null for a thread that started no agent", () => {
    expect(lineageForThread("claude", [])).toBeNull();
    expect(lineageForThread("hermes", [])).toBeNull();
  });

  it("lists several children in the order they started", () => {
    const rows = children(
      lineageForThread("claude", [
        agentBlock({
          id: "b1",
          tool: { callId: "a", kind: "agent", title: "First", status: "completed" },
          agentRun: { name: "First", steps: [] },
        }),
        { id: "r", role: "tool", text: "Read", tool: { kind: "read", status: "completed" } },
        agentBlock({
          id: "b2",
          tool: { callId: "b", kind: "agent", title: "Second", status: "in_progress" },
          agentRun: { name: "Second", steps: [] },
        }),
      ]),
    );
    expect(rows.map((row) => [row.id, row.name, row.status])).toEqual([
      ["a", "First", "done"],
      ["b", "Second", "running"],
    ]);
  });

  it("folds two rows of the same call onto one child", () => {
    expect(children(lineageForThread("codex", [agentBlock(), agentBlock({ id: "b2" })]))).toHaveLength(1);
  });

  it("keeps the finished copy when a later row of the same call is still running", () => {
    const row = only(
      lineageForThread("claude", [
        agentBlock(),
        agentBlock({
          id: "b2",
          agentRun: undefined,
          tool: { callId: "toolu_agent", kind: "agent", title: "Subagent", status: "in_progress" },
        }),
      ]),
    );
    expect(row).toMatchObject({
      status: "done",
      result: "Auth lives in src/auth.",
      name: "Explore the auth module",
    });
  });

  it("takes a newer failure without wiping the name", () => {
    const row = only(
      lineageForThread("claude", [
        agentBlock({
          tool: { callId: "toolu_agent", kind: "agent", title: "Explore the auth module", status: "in_progress" },
        }),
        agentBlock({
          id: "b2",
          agentRun: undefined,
          tool: { callId: "toolu_agent", kind: "agent", title: "Subagent", status: "failed", detail: "Timed out." },
        }),
      ]),
    );
    expect(row).toMatchObject({ name: "Explore the auth module", status: "failed", error: "Timed out." });
  });
});

describe("a CLI that does not report children", () => {
  it("labels the provider and does not turn a lookalike row into a list", () => {
    for (const provider of ["hermes", "cursor", "pi", "devin", "opencode", ""]) {
      expect(lineageForThread(provider, [agentBlock()])).toEqual({
        reported: false,
        label: NOT_REPORTED_BY_CLI,
        children: [],
      });
    }
  });

  it("reads the provider name without regard to case or spaces", () => {
    expect(lineageForThread(" Claude ", [agentBlock()])?.reported).toBe(true);
    expect(lineageForThread("CODEX", [agentBlock()])?.reported).toBe(true);
  });
});

describe("the one-line tally the list opens with", () => {
  const child = (status: LineageChild["status"], id: string): LineageChild => ({
    id,
    name: id,
    role: null,
    model: null,
    status,
    result: null,
    error: null,
  });

  it("counts each state in a fixed order and leaves out the empty ones", () => {
    expect(
      lineageTally([
        child("done", "a"),
        child("failed", "b"),
        child("running", "c"),
        child("done", "d"),
        child("cancelled", "e"),
        child("running", "f"),
      ]),
    ).toBe("2 working, 2 done, 1 failed, 1 stopped");
    expect(lineageTally([child("done", "a")])).toBe("1 done");
  });

  it("has no dash in it and says nothing for no children", () => {
    expect(lineageTally([])).toBe("");
    expect(lineageTally([child("failed", "a"), child("done", "b")])).not.toMatch(/[\u2013\u2014]/);
  });
});
