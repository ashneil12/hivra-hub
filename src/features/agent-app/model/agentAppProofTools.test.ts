// @vitest-environment happy-dom
// PT-1: who may use the `proof_tools` tool from a chat (`proof_tools.list`, `proof_tools.propose`), that a proposal files ONE
// Needs-you question through the existing ask path, at most once per project per tool, and that a question that couldn't be
// filed is not a final "no". The app's side (detection, the once-per-project record) is a fake here; src-tauri/src/proof_tools
// tests the real one.
import { describe, expect, it, vi } from "vitest";
import { CHECKER_MONO_ID } from "../../hub/model/hubMcp";
import { newSession, type Session } from "../../sessions/model/session";
import { appActions, handleAgentApp, type AgentAppHost } from "./agentApp";
import type { ProofToolsBackend } from "./agentAppProofTools";

vi.mock("../../../integrations/harness/core/availability", () => ({ isHarnessAvailable: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

type Status = "open" | "proposed" | "declined";
type Who = "mono" | "team" | "worker" | "habit" | "habit-mono" | "checker" | "mono-two";

const KEY = "proof-tools/fast-check/0123456789ab";
const QUESTION = "Add fast-check to catch inputs that break the code the examples missed?";
const INSTALL = "npm install --save-dev fast-check@4.10.2";

const LIST = {
  stacks: ["node"],
  tools: [
    {
      id: "fast-check",
      name: "fast-check",
      proves: "Properties hold for generated inputs, not just the examples.",
      howToUse: "Write a property test with fast-check next to the code you change; it runs with the project's own tests.",
      kind: "property",
      external: false,
      installed: false,
      status: "open",
    },
  ],
};

/** What src-tauri/src/proof_tools/offers.rs `ClaimView` says. */
function claimView(over: Record<string, unknown> = {}) {
  return {
    claimed: true,
    status: "proposed",
    revision: 1,
    key: KEY,
    question: QUESTION,
    options: ["Add it", "Not now"],
    recommended: "Add it",
    tool: { id: "fast-check", name: "fast-check", proves: "x", install: INSTALL, pinned: "4.10.2", licence: "MIT", repo: "https://github.com/dubzzz/fast-check", external: false },
    note: "Not proposed before for this project. File the question now.",
    ...over,
  };
}

/** A store that behaves like the real one: the first claim claims, later ones don't, a release undoes only its own claim. */
function fakeStore(initial: Status = "open") {
  let status = initial;
  let revision = 0;
  const backend: ProofToolsBackend = {
    list: vi.fn(async (_folder: string): Promise<unknown> => LIST),
    claim: vi.fn(async (_folder: string, _toolId: string): Promise<unknown> => {
      if (status !== "open")
        return claimView({
          claimed: false,
          status,
          revision,
          note: status === "declined" ? "The person said not now for this project. Don't propose it again." : "Already proposed to the person for this project; it won't be proposed again.",
        });
      status = "proposed";
      revision += 1;
      return claimView({ revision });
    }),
    release: vi.fn(async (_folder: string, _toolId: string, asked: number): Promise<unknown> => {
      if (status === "proposed" && asked === revision) {
        status = "open";
        revision += 1;
        return true;
      }
      return false;
    }),
  };
  return { backend, status: () => status };
}

function fixture(who: Who, store = fakeStore()) {
  const source: Session = {
    // A Mono with two projects works from a folder of its own, so it has to name the project it means.
    ...newSession("claude", who === "mono-two" ? "/code/mono-home" : "/code/hivra", "claude:opus-5-5"),
    id: who === "worker" ? "app-w1" : `chat-${who}`,
  };
  const projects = who === "mono-two" ? ["/code/hivra", "/code/other"] : ["/code/hivra"];
  const ask = vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({
    decision: { project: input.project, decisionKey: input.key, state: "open", waiting: [], answer: null },
    created: true,
    added: [],
    released: [],
  }));
  const host = {
    isMono: () => who === "mono" || who === "mono-two" || who === "checker" || who === "habit-mono",
    isHabitRun: () => who === "habit" || who === "habit-mono",
    monoOf: () =>
      who === "mono" || who === "mono-two" || who === "habit" || who === "habit-mono" || who === "checker"
        ? { id: who === "checker" ? CHECKER_MONO_ID : "hivra-lead", name: "Hivra lead", projects }
        : undefined,
    codingTeamOf: () => (who === "team" ? { project: "hivra", name: "Hivra coding team", folder: "/code/hivra" } : undefined),
    // The existing ask path: tasks.ask reaches the decision store through the first-mate backend.
    tasks: { firstMate: { backend: { ask } } },
    proofTools: store.backend,
  } as unknown as AgentAppHost;
  return { source, host, ask, store };
}

describe("proof_tools actions", () => {
  it("are app actions a first mate can call", () => {
    expect(appActions()).toEqual(expect.arrayContaining(["proof_tools.list", "proof_tools.propose"]));
  });

  it("list answers with the tools that fit, for the chat's own project, and says the app installs nothing", async () => {
    const { source, host, store } = fixture("mono");
    const answer = (await handleAgentApp(source, "r1", "proof_tools.list", {}, host)) as Record<string, unknown>;
    expect(store.backend.list).toHaveBeenCalledWith("/code/hivra");
    expect(answer.project).toBe("/code/hivra");
    expect(JSON.stringify(answer.tools)).toContain("fast-check");
    expect(String(answer.note)).toContain("installs nothing");
    expect(store.backend.claim).not.toHaveBeenCalled();
  });

  it("a list the app can't read is an error, not an empty list", async () => {
    const { source, host, store } = fixture("mono");
    vi.mocked(store.backend.list).mockResolvedValueOnce({ nope: true });
    await expect(handleAgentApp(source, "r1", "proof_tools.list", {}, host)).rejects.toThrow(/couldn't be read/);
  });

  it("propose files exactly one question through the existing ask path, with the install command handed back, not run", async () => {
    const { source, host, ask, store } = fixture("mono");
    const answer = (await handleAgentApp(source, "r1", "proof_tools.propose", { toolId: "fast-check" }, host)) as Record<string, unknown>;
    expect(store.backend.claim).toHaveBeenCalledWith("/code/hivra", "fast-check");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        askedBy: "chat-mono",
        askedByMono: "hivra-lead",
        key: KEY,
        question: QUESTION,
        options: ["Add it", "Not now"],
        recommended: "Add it",
        taskIds: [],
      }),
    );
    expect(answer).toMatchObject({ proposed: true, toolId: "fast-check", key: KEY, question: QUESTION, install: INSTALL });
    expect(String(answer.note)).toContain(`brief a worker to run: ${INSTALL}`);
    expect(String(answer.note)).toContain("the app does not install anything itself");
    expect(String(answer.note)).toContain("Not now");
    // The app only ever hands the command back; nothing in this path runs one.
    expect(store.backend.release).not.toHaveBeenCalled();
  });

  it("a second propose asks nothing: once per project per tool", async () => {
    const { source, host, ask } = fixture("mono");
    await handleAgentApp(source, "r1", "proof_tools.propose", { toolId: "fast-check" }, host);
    const again = (await handleAgentApp(source, "r2", "proof_tools.propose", { toolId: "fast-check" }, host)) as Record<string, unknown>;
    expect(again).toMatchObject({ proposed: false, status: "proposed" });
    expect(String(again.note)).toContain("won't be proposed again");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("two first mates proposing at once ask once", async () => {
    const store = fakeStore();
    const a = fixture("mono", store);
    const b = fixture("team", store);
    const [first, second] = (await Promise.all([
      handleAgentApp(a.source, "r1", "proof_tools.propose", { toolId: "fast-check" }, a.host),
      handleAgentApp(b.source, "r2", "proof_tools.propose", { toolId: "fast-check" }, b.host),
    ])) as Record<string, unknown>[];
    expect([first.proposed, second.proposed].sort()).toEqual([false, true]);
    expect(a.ask.mock.calls.length + b.ask.mock.calls.length).toBe(1);
  });

  it("a tool the person already declined for this project asks nothing", async () => {
    const { source, host, ask } = fixture("mono", fakeStore("declined"));
    const answer = (await handleAgentApp(source, "r1", "proof_tools.propose", { toolId: "fast-check" }, host)) as Record<string, unknown>;
    expect(answer).toMatchObject({ proposed: false, status: "declined" });
    expect(String(answer.note)).toContain("Don't propose it again");
    expect(ask).not.toHaveBeenCalled();
  });

  it("a question that couldn't be filed releases the claim, so the next propose can ask: not a final no", async () => {
    const { source, host, ask, store } = fixture("mono");
    ask.mockRejectedValueOnce(new Error("The decision store didn't answer"));
    await expect(handleAgentApp(source, "r1", "proof_tools.propose", { toolId: "fast-check" }, host)).rejects.toThrow(
      "The decision store didn't answer",
    );
    expect(store.backend.release).toHaveBeenCalledWith("/code/hivra", "fast-check", 1);
    expect(store.status()).toBe("open");
    const retry = (await handleAgentApp(source, "r2", "proof_tools.propose", { toolId: "fast-check" }, host)) as Record<string, unknown>;
    expect(retry.proposed).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(store.status()).toBe("proposed");
  });

  it("a release that itself fails still reports the ask's own failure", async () => {
    const { source, host, ask, store } = fixture("mono");
    ask.mockRejectedValueOnce(new Error("Only a first mate's own chat asks the person."));
    vi.mocked(store.backend.release).mockRejectedValueOnce(new Error("locked"));
    await expect(handleAgentApp(source, "r1", "proof_tools.propose", { toolId: "fast-check" }, host)).rejects.toThrow(
      "Only a first mate's own chat asks the person.",
    );
  });

  it("an ask that comes back already answered says so instead of asking twice", async () => {
    const { source, host, ask } = fixture("mono");
    ask.mockResolvedValueOnce({
      decision: { project: "/code/hivra", decisionKey: KEY, state: "answered", answer: "Not now", answeredBy: "person", question: QUESTION, options: ["Add it", "Not now"], waiting: [] },
      created: false,
      added: [],
      released: [],
    });
    const answer = (await handleAgentApp(source, "r1", "proof_tools.propose", { toolId: "fast-check" }, host)) as Record<string, unknown>;
    expect(answer).toMatchObject({ proposed: true, answer: "Not now" });
    expect(String(answer.note)).toContain("Don't propose it again");
    expect(String(answer.note)).not.toContain("brief a worker");
  });

  it("only a first mate's own chat may use it", async () => {
    const worker = fixture("worker");
    await expect(handleAgentApp(worker.source, "r1", "proof_tools.list", {}, worker.host)).rejects.toThrow(
      /Only a first mate's own chat/,
    );
    await expect(handleAgentApp(worker.source, "r2", "proof_tools.propose", { toolId: "fast-check" }, worker.host)).rejects.toThrow(
      /Only a first mate's own chat/,
    );
    const habit = fixture("habit");
    await expect(handleAgentApp(habit.source, "r1", "proof_tools.propose", { toolId: "fast-check" }, habit.host)).rejects.toThrow(
      /habit run doesn't propose/,
    );
    const habitMono = fixture("habit-mono");
    await expect(handleAgentApp(habitMono.source, "r1", "proof_tools.list", {}, habitMono.host)).rejects.toThrow(/habit run/);
    const checker = fixture("checker");
    await expect(handleAgentApp(checker.source, "r1", "proof_tools.list", {}, checker.host)).rejects.toThrow(/checker only reads/);
    for (const refused of [worker, habit, habitMono, checker]) {
      expect(refused.ask).not.toHaveBeenCalled();
      expect(refused.store.backend.claim).not.toHaveBeenCalled();
      expect(refused.store.backend.list).not.toHaveBeenCalled();
    }
    // A Mono's chat and a coding-team chat both may.
    const team = fixture("team");
    await expect(handleAgentApp(team.source, "r1", "proof_tools.list", {}, team.host)).resolves.toBeTruthy();
  });

  it("refuses unknown fields, a missing or odd toolId and a toolId on list, before anything is read", async () => {
    const { source, host, ask, store } = fixture("mono");
    await expect(
      handleAgentApp(source, "r1", "proof_tools.propose", { toolId: "fast-check", path: "/etc" }, host),
    ).rejects.toThrow(/Unknown proof_tools.propose fields: path/);
    await expect(handleAgentApp(source, "r2", "proof_tools.list", { toolId: "fast-check" }, host)).rejects.toThrow(
      /Unknown proof_tools.list fields: toolId/,
    );
    for (const bad of [undefined, "", "  ", "../x", "FAST-CHECK", "fast check", "a".repeat(41), 7, ["fast-check"]]) {
      const input = bad === undefined ? {} : { toolId: bad };
      await expect(handleAgentApp(source, "r3", "proof_tools.propose", input, host)).rejects.toThrow(/toolId must be/);
    }
    await expect(handleAgentApp(source, "r4", "proof_tools.install", { toolId: "fast-check" }, host)).rejects.toThrow(
      /Unknown app action/,
    );
    expect(store.backend.claim).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it("a claim answer the app sent badly is refused and nothing is asked", async () => {
    const { source, host, ask, store } = fixture("mono");
    const bad: unknown[] = [
      null,
      "claimed",
      { claimed: true },
      claimView({ status: "maybe" }),
      claimView({ revision: -1 }),
      claimView({ revision: 1.5 }),
      claimView({ key: "" }),
      claimView({ options: ["Add it"] }),
      claimView({ recommended: "Install it" }),
      claimView({ tool: { id: "fast-check" } }),
      claimView({ note: 3 }),
    ];
    for (const payload of bad) {
      vi.mocked(store.backend.claim).mockResolvedValueOnce(payload);
      await expect(handleAgentApp(source, "r1", "proof_tools.propose", { toolId: "fast-check" }, host)).rejects.toThrow(
        /couldn't be read/,
      );
    }
    expect(ask).not.toHaveBeenCalled();
    expect(store.backend.release).not.toHaveBeenCalled();
  });

  it("a Mono with two projects names the one it means", async () => {
    const { source, host, store } = fixture("mono-two");
    await expect(handleAgentApp(source, "r1", "proof_tools.list", {}, host)).rejects.toThrow(/Pass "project"/);
    await handleAgentApp(source, "r2", "proof_tools.list", { project: "/code/other" }, host);
    expect(store.backend.list).toHaveBeenCalledWith("/code/other");
    await expect(handleAgentApp(source, "r3", "proof_tools.list", { project: "/code/elsewhere" }, host)).rejects.toThrow(
      /Not one of your projects/,
    );
    expect(store.backend.list).toHaveBeenCalledTimes(1);
  });
});
