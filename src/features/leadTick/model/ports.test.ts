import { describe, expect, it } from "vitest";
import { DEFAULT_BUILDER_SCALE } from "../../monos/model/builderScale";
import { appPorts, outcomeOf, slotAnswer, type PortHost } from "./ports";

function pkg(id: string) {
  return {
    id,
    projectId: "app",
    wp: "WP-300",
    title: "Build it",
    briefPath: "docs/hivra/work/WP-300.md",
    branch: `wp/300-${id}`,
    status: "queued",
    securityPark: false,
    priority: 0,
    notes: "",
    parkReason: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    claimedAt: null,
    finishedAt: null,
  };
}

const scale = { ...DEFAULT_BUILDER_SCALE, load: { kind: "default" as const } };

describe("builder slot", () => {
  it("is free under the project's worker limit with a healthy machine", () => {
    expect(slotAnswer({ limits: { workers: 6 }, running: 2, waiting: 1, inFlight: 1, health: null, scale })).toEqual({ ok: true });
  });

  it("is full at the limit, counting waiting workers and packages already building", () => {
    expect(slotAnswer({ limits: { workers: 3 }, running: 2, waiting: 1, inFlight: 0, health: null, scale }).ok).toBe(false);
    const held = slotAnswer({ limits: { workers: 3 }, running: 0, waiting: 0, inFlight: 3, health: null, scale });
    expect(held).toEqual({ ok: false, reason: "all 3 builder slots for this project are in use." });
  });

  it("follows the builder health pause (WP-161)", () => {
    const answer = slotAnswer({
      limits: { workers: 6 },
      running: 0,
      waiting: 0,
      inFlight: 0,
      health: { freeDiskGb: 12, readAt: Date.now(), now: Date.now() } as never,
      scale,
    });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.reason).toContain("disk");
  });
});

describe("app ports", () => {
  const context = { projectId: "app", lead: { monoId: "app-lead", name: "Lead", sessionId: "s-lead" }, look: { busy: false, asking: false, queued: false, limited: false, resumeStopped: false } };

  function host() {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const delegated: unknown[] = [];
    const value: PortHost = {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "programme_list") return [{ nope: true }];
        if (command === "delivery_merge") return { outcome: "needsYou", head_sha: "abc", question: "Merge it?" };
        return null;
      },
      slot: () => ({ ok: true }),
      delegate: async (...args) => {
        delegated.push(args);
        return { status: "running" };
      },
    };
    return { value, calls, delegated };
  }

  it("acts on the programme as the project's First Mate and drops unreadable rows", async () => {
    const h = host();
    const ports = appPorts(h.value, "/code/app", context);
    expect(await ports.list()).toEqual([]);
    expect(h.calls[0]).toEqual({ command: "programme_list", args: { actor: { id: "s-lead", project: "app", kind: "first-mate" } } });
  });

  it("hands the tick the board best first, whatever order the store answered in", async () => {
    const h = host();
    const low = { ...pkg("low"), priority: 0, createdAt: 1 };
    const high = { ...pkg("high"), priority: 5, createdAt: 9 };
    h.value.invoke = async (command) => (command === "programme_list" ? [low, high] : null);
    const rows = await appPorts(h.value, "/code/app", context).list();
    expect(rows.map((row) => row.id)).toEqual(["high", "low"]);
  });

  it("keeps a row with a long title or note, so the tick still sees it", async () => {
    const h = host();
    const long = { ...pkg("long"), title: "t".repeat(400), notes: "n".repeat(2500) };
    h.value.invoke = async (command) => (command === "programme_list" ? [long] : null);
    const rows = await appPorts(h.value, "/code/app", context).list();
    expect(rows.map((row) => row.id)).toEqual(["long"]);
  });

  it("merges through delivery's merge path as the First Mate, never as the person", async () => {
    const h = host();
    const ports = appPorts(h.value, "/code/app", context);
    expect(await ports.merge("o/app", 7)).toEqual({ outcome: "needsYou", headSha: "abc", question: "Merge it?" });
    expect(h.calls[0].args).toEqual({ input: { repo: "o/app", number: 7, caller: { kind: "agent", session: "s-lead" }, method: "merge" } });
  });

  it("delegates as the Lead's own chat", async () => {
    const h = host();
    await appPorts(h.value, "/code/app", context).delegate("lead-tick-a-2", { title: "x" });
    expect(h.delegated).toEqual([["s-lead", "lead-tick-a-2", { title: "x" }]]);
  });

  it("writes the activity line as the Lead, cut to the log's limit", async () => {
    const h = host();
    appPorts(h.value, "/code/app", context).note("x".repeat(900));
    const args = h.calls[0].args!;
    expect(h.calls[0].command).toBe("activity_note");
    expect(args.kind).toBe("lead.tick");
    expect(args.actorId).toBe("app-lead");
    expect(String(args.summary).length).toBeLessThan(500);
  });

  it("reads an unknown merge answer as a refusal", () => {
    expect(outcomeOf(null)).toEqual({ outcome: "refused", reason: "The merge path gave no answer." });
    expect(outcomeOf({ outcome: "merged", head_sha: "h", allowed_by: "switch" })).toEqual({ outcome: "merged", headSha: "h", allowedBy: "switch" });
  });
});
