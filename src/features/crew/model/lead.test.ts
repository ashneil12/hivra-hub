import { describe, expect, it, vi } from "vitest";
import { cliForLeadBrief, refuseBriefedLeadHarness, refuseNeverUseLead } from "./lead";

const target = { leadId: "lead-x", leadName: "Lead X", folder: "/tmp/project-x", cli: "claude" };

describe("WP-141 LOW 7 and M5: a Lead on Never use is not briefed, read from the Lead's own project", () => {
  it("reads the policy of the target Lead's project, not the briefing Mono's folder", async () => {
    const read = vi.fn(async () => ({ neverUse: [] as string[] }));
    await refuseNeverUseLead(target, "briefer", read);
    expect(read).toHaveBeenCalledWith("briefer", "/tmp/project-x");
  });

  it("refuses a Lead whose CLI is on Never use, with the sentence the brief returns", async () => {
    const read = vi.fn(async () => ({ neverUse: ["claude"] }));
    await expect(refuseNeverUseLead(target, "briefer", read)).rejects.toThrow(
      "Lead X is on Never use, so it can't be briefed.",
    );
  });

  // MED-D: the list holds CLI ids. A Lead whose id happens to sit on it is not refused for that, and a Lead on a banned
  // CLI is refused whatever its id is.
  it("judges the Lead's CLI, not its Mono id", async () => {
    const read = vi.fn(async () => ({ neverUse: ["lead-x"] }));
    await expect(refuseNeverUseLead(target, "briefer", read)).resolves.toBeUndefined();
    const onBanned = vi.fn(async () => ({ neverUse: ["codex"] }));
    await expect(
      refuseNeverUseLead({ ...target, cli: "codex" }, "briefer", onBanned),
    ).rejects.toThrow("Lead X is on Never use");
  });

  it("a Lead whose CLI is not known is not briefed", async () => {
    const read = vi.fn(async () => ({ neverUse: [] as string[] }));
    await expect(refuseNeverUseLead({ ...target, cli: undefined }, "briefer", read)).rejects.toThrow(
      "CLI is unknown",
    );
  });

  it("an unreadable policy refuses the brief too", async () => {
    const read = vi.fn(async () => {
      throw new Error("The crew policy could not be read, so nothing was started (db locked).");
    });
    await expect(refuseNeverUseLead(target, "briefer", read)).rejects.toThrow("could not be read");
  });
});

const named = { leadId: target.leadId, leadName: target.leadName, folder: target.folder };

describe("the CLI a Lead brief will run", () => {
  it("a Lead with no session yet is briefed when its default CLI is allowed, and refused when that CLI is on Never use", async () => {
    const load = vi.fn();
    const createDefault = vi.fn(() => ({ harness: "claude", model: "default-model" }));
    const cli = await cliForLeadBrief({ mono: {}, openSessions: [], load, createDefault });
    expect(cli).toBe("claude");
    expect(createDefault).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    const allow = vi.fn(async () => ({ neverUse: [] as string[] }));
    await expect(refuseNeverUseLead({ ...target, cli }, "briefer", allow)).resolves.toBeUndefined();
    expect(allow).toHaveBeenCalledWith("briefer", "/tmp/project-x");
    await expect(
      refuseNeverUseLead({ ...target, cli }, "briefer", async () => ({ neverUse: ["claude"] })),
    ).rejects.toThrow("Lead X is on Never use, so it can't be briefed.");
  });

  it("a Lead whose session exists but is not loaded is judged on its stored harness", async () => {
    const load = vi.fn(async () => ({ id: "saved-chat", harness: "codex" }));
    const createDefault = vi.fn(() => ({ harness: "claude" }));
    const cli = await cliForLeadBrief({
      mono: { sessionId: "saved-chat" },
      openSessions: [{ id: "someone-else", harness: "claude" }],
      load,
      createDefault,
    });
    expect(cli).toBe("codex");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("saved-chat");
    expect(createDefault).not.toHaveBeenCalled();
    await expect(
      refuseNeverUseLead({ ...target, cli }, "briefer", async () => ({ neverUse: ["codex"] })),
    ).rejects.toThrow("on Never use");
    await expect(
      refuseNeverUseLead({ ...target, cli }, "briefer", async () => ({ neverUse: ["claude"] })),
    ).resolves.toBeUndefined();
  });

  it("an open chat is judged on its harness, and a blank one is not replaced with the default", async () => {
    const load = vi.fn(async () => ({ id: "open-1", harness: "codex" }));
    const createDefault = vi.fn(() => ({ harness: "claude" }));
    const open = await cliForLeadBrief({
      mono: { sessionId: "open-1" },
      openSessions: [{ id: "open-1", harness: "grok" }],
      load,
      createDefault,
    });
    expect(open).toBe("grok");
    expect(load).not.toHaveBeenCalled();
    const blank = await cliForLeadBrief({
      mono: { sessionId: "open-1" },
      openSessions: [{ id: "open-1", harness: "  " }],
      load,
      createDefault,
    });
    expect(blank).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(createDefault).not.toHaveBeenCalled();
  });

  it("a new chat uses the Lead's own engine when that is the CLI it will run, and the app default otherwise", async () => {
    const onEngine = await cliForLeadBrief({
      mono: { engine: "codex", engineModel: "other-model" },
      openSessions: [],
      load: vi.fn(),
      createDefault: () => ({ harness: "claude", model: "default-model" }),
    });
    expect(onEngine).toBe("codex");
    await expect(
      refuseNeverUseLead({ ...target, cli: onEngine }, "briefer", async () => ({ neverUse: ["codex"] })),
    ).rejects.toThrow("on Never use");
    const sameEngine = await cliForLeadBrief({
      mono: { engine: "claude", engineModel: "other-model" },
      openSessions: [],
      load: vi.fn(),
      createDefault: () => ({ harness: "claude", model: "default-model" }),
    });
    expect(sameEngine).toBe("claude");
    const unknownEngine = await cliForLeadBrief({
      mono: { engine: "toString" },
      openSessions: [],
      load: vi.fn(),
      createDefault: () => ({ harness: "claude" }),
    });
    expect(unknownEngine).toBe("claude");
  });

  it("a saved chat that is gone is judged as the new chat, and a load that fails is not a final unknown CLI", async () => {
    const created = vi.fn(() => ({ harness: "claude" }));
    const gone = await cliForLeadBrief({
      mono: { sessionId: "missing" },
      openSessions: [],
      load: async () => null,
      createDefault: created,
    });
    expect(gone).toBe("claude");
    expect(created).toHaveBeenCalledTimes(1);
    const createDefault = vi.fn(() => ({ harness: "claude" }));
    await expect(
      cliForLeadBrief({
        mono: { sessionId: "saved-chat" },
        openSessions: [],
        load: async () => {
          throw new Error("disk asleep");
        },
        createDefault,
      }),
    ).rejects.toThrow("disk asleep");
    expect(createDefault).not.toHaveBeenCalled();
  });
});

describe("the delegator judges the chat it is about to brief", () => {
  it("the delegator refuses when the briefed session's harness is on Never use", async () => {
    const launch = vi.fn();
    const read = vi.fn(async () => ({ neverUse: ["codex"] }));
    await expect(
      (async () => {
        await refuseBriefedLeadHarness({ harness: "codex" }, named, "briefer", read);
        launch();
      })(),
    ).rejects.toThrow("Lead X is on Never use, so it can't be briefed.");
    expect(launch).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith("briefer", "/tmp/project-x");
    await expect(
      refuseBriefedLeadHarness({ harness: "claude" }, named, "briefer", async () => ({ neverUse: ["codex"] })),
    ).resolves.toBeUndefined();
    await expect(
      refuseBriefedLeadHarness({ harness: "  " }, named, "briefer", async () => ({ neverUse: [] })),
    ).rejects.toThrow("CLI is unknown");
  });
});
