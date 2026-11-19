import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../memory/backpass/sha";
import type { PendingEdit } from "./retro";
import { parseRetroState } from "./retroStage";
import { acceptStaged, listStaged, rejectStaged, stageRetroEdits } from "./retroStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const AT = "2026-11-10T09:00:00.000Z";

function edit(text: string, days: string[] = ["2026-11-10"], title = "A correction from the week"): PendingEdit {
  return {
    id: `retro:${text}`,
    file: "opinions.md",
    title,
    text,
    evidence: days.map((day) => ({ day, line: `Feedback on ${day}.` })),
  };
}

type Call = { command: string; args: Record<string, unknown> };

/** The learn store's four commands, in memory, with the same hash and revision rules. */
function fakeLearnStore(initial: { opinions?: string; state?: Record<string, unknown> } = {}) {
  const store = {
    opinions: initial.opinions ?? "# Opinions\n",
    revision: 1,
    state: initial.state ?? ({} as Record<string, unknown>),
    calls: [] as Call[],
    failStateWrites: 0,
    failProfileSaves: 0,
  };
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const input = (args ?? {}) as Record<string, unknown>;
    store.calls.push({ command, args: input });
    if (command === "learn_state_load") return { revision: store.revision, state: store.state };
    if (command === "learn_state_cas") {
      if (store.failStateWrites > 0) {
        store.failStateWrites -= 1;
        return false;
      }
      if (input.revision !== store.revision) return false;
      store.revision += 1;
      store.state = input.state as Record<string, unknown>;
      return true;
    }
    if (command === "learn_profile_load") {
      return {
        opinions: store.opinions,
        voice: "",
        agents: "",
        claude: "",
        opinionsSha256: sha256(store.opinions),
        voiceSha256: sha256(""),
        agentsSha256: sha256(""),
        claudeSha256: sha256(""),
      };
    }
    if (command === "learn_profile_save") {
      if (store.failProfileSaves > 0) {
        store.failProfileSaves -= 1;
        return false;
      }
      if (input.which !== "opinions" || input.expectedSha256 !== sha256(store.opinions)) return false;
      store.opinions = String(input.next);
      return true;
    }
    throw new Error(`unexpected command ${command}`);
  });
  return store;
}

const writes = (store: ReturnType<typeof fakeLearnStore>) =>
  store.calls.filter((call) => call.command === "learn_profile_save" || call.command === "learn_apply_edit");

describe("staging a retro", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("queues the edits as pending and never writes a profile file", async () => {
    const store = fakeLearnStore({ state: { ledger: { version: 1, entries: {} } } });
    const outcome = await stageRetroEdits([edit("Keep the line short."), edit("Name the file.")], AT);
    expect(outcome).toEqual({ staged: 2, waiting: 2, declined: 0, present: 0, full: 0 });
    expect(parseRetroState(store.state).staged.map((row) => row.text)).toEqual([
      "Keep the line short.",
      "Name the file.",
    ]);
    expect(store.state).toMatchObject({ ledger: { version: 1, entries: {} } });
    expect(store.opinions).toBe("# Opinions\n");
    expect(writes(store)).toEqual([]);
  });

  it("a lost race is tried again, and a second lost race is said out loud", async () => {
    const store = fakeLearnStore();
    store.failStateWrites = 1;
    await expect(stageRetroEdits([edit("Keep the line short.")], AT)).resolves.toMatchObject({ staged: 1 });
    expect(parseRetroState(store.state).staged).toHaveLength(1);

    const stuck = fakeLearnStore();
    stuck.failStateWrites = 99;
    await expect(stageRetroEdits([edit("Keep the line short.")], AT)).rejects.toThrow(
      "The edits could not be queued. Try again.",
    );
    expect(parseRetroState(stuck.state).staged).toEqual([]);
    expect(writes(stuck)).toEqual([]);
  });

  it("running it again changes nothing, and still says what is waiting", async () => {
    const store = fakeLearnStore();
    await stageRetroEdits([edit("Keep the line short.")], AT);
    const revision = store.revision;
    const again = await stageRetroEdits([edit("Keep the line short.")], "2026-11-17T09:00:00.000Z");
    expect(again.waiting).toBe(1);
    expect(store.revision).toBe(revision);
    const nothing = await stageRetroEdits([], "2026-11-17T09:00:00.000Z");
    expect(nothing).toEqual({ staged: 0, waiting: 1, declined: 0, present: 0, full: 0 });
    expect(store.revision).toBe(revision);
  });
});

describe("the waiting edits in the learn screen", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("lists them with their log lines, writes nothing, and says when agents will not see one yet", async () => {
    const store = fakeLearnStore();
    await stageRetroEdits(
      [edit("Keep the line short."), edit("Check the brief.", ["2026-11-09", "2026-11-10"], "Work sent back")],
      AT,
    );
    const before = store.calls.length;
    const shown = await listStaged();
    expect(shown.map((row) => row.title)).toEqual(["A correction from the week", "Work sent back"]);
    expect(shown[0].diff).toContain("+ Keep the line short.");
    expect(shown[0].quotes).toEqual([{ sessionId: "work log 2026-11-10", quote: "Feedback on 2026-11-10." }]);
    expect(shown[0].note).toBe("Agents will see this once a second log line backs it.");
    expect(shown[1].note).toBeUndefined();
    expect(shown[1].quotes).toHaveLength(2);
    expect(writes(store)).toEqual([]);
    expect(store.calls.slice(before).every((call) => call.command.endsWith("_load"))).toBe(true);
  });

  it("accepting writes that one block with the file's hash, then clears it", async () => {
    const store = fakeLearnStore({ opinions: "# Opinions\n\n## Small commits\n\nCommit small.\n" });
    await stageRetroEdits([edit("Keep the line short."), edit("Name the file.")], AT);
    const [first] = parseRetroState(store.state).staged;
    const hash = sha256(store.opinions);

    await expect(acceptStaged(first.id)).resolves.toBe(true);

    const saves = writes(store);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual({
      command: "learn_profile_save",
      args: { which: "opinions", expectedSha256: hash, next: store.opinions },
    });
    expect(store.opinions).toContain("## Small commits");
    expect(store.opinions).toContain("Keep the line short.");
    expect(store.opinions).not.toContain("Name the file.");
    expect(parseRetroState(store.state).staged.map((row) => row.text)).toEqual(["Name the file."]);
    await expect(acceptStaged(first.id)).resolves.toBe(false);
    expect(writes(store)).toHaveLength(1);
  });

  it("a file that changed under the accept is not overwritten, and the edit stays waiting", async () => {
    const store = fakeLearnStore();
    await stageRetroEdits([edit("Keep the line short.")], AT);
    const [first] = parseRetroState(store.state).staged;
    store.failProfileSaves = 1;
    await expect(acceptStaged(first.id)).resolves.toBe(false);
    expect(store.opinions).toBe("# Opinions\n");
    expect(parseRetroState(store.state).staged).toHaveLength(1);
    await expect(acceptStaged(first.id)).resolves.toBe(true);
    expect(store.opinions).toContain("Keep the line short.");
  });

  it("an accept whose clean up failed is not written twice when it is tried again", async () => {
    const store = fakeLearnStore();
    await stageRetroEdits([edit("Keep the line short.")], AT);
    const [first] = parseRetroState(store.state).staged;
    store.failStateWrites = 99;
    await expect(acceptStaged(first.id)).resolves.toBe(false);
    expect(store.opinions).toContain("Keep the line short.");
    store.failStateWrites = 0;
    await expect(acceptStaged(first.id)).resolves.toBe(true);
    expect(store.opinions.split("Keep the line short.")).toHaveLength(2);
    expect(parseRetroState(store.state).staged).toEqual([]);
  });

  it("rejecting writes no profile, and the next retro does not offer it again", async () => {
    const store = fakeLearnStore();
    await stageRetroEdits([edit("Keep the line short.")], AT);
    const [first] = parseRetroState(store.state).staged;
    await expect(rejectStaged(first.id)).resolves.toBe(true);
    expect(store.opinions).toBe("# Opinions\n");
    expect(writes(store)).toEqual([]);
    expect(parseRetroState(store.state)).toMatchObject({ staged: [], declined: [first.id] });
    const again = await stageRetroEdits([edit("Keep the line short.")], "2026-11-17T09:00:00.000Z");
    expect(again).toEqual({ staged: 0, waiting: 0, declined: 1, present: 0, full: 0 });
    await expect(rejectStaged(first.id)).resolves.toBe(false);
  });

  it("a file with no room refuses the accept in plain words and writes nothing", async () => {
    const store = fakeLearnStore();
    await stageRetroEdits([edit("Keep the line short.")], AT);
    const [first] = parseRetroState(store.state).staged;
    store.opinions = `# Opinions\n\n${"x".repeat(6_000)}\n`;
    await expect(acceptStaged(first.id)).rejects.toThrow("Opinions is full. Remove or merge something there first.");
    expect(writes(store)).toEqual([]);
    const shown = await listStaged();
    expect(shown[0].note).toBe("Opinions is full. Remove or merge something there first.");
  });

  it("an edit that looks like a secret, hand written into the state, is not saved", async () => {
    const store = fakeLearnStore({
      state: {
        retro: {
          staged: [{ ...edit("Set API_KEY=supersecretvalue first."), stagedAt: AT }],
          declined: [],
        },
      },
    });
    await expect(acceptStaged("retro:Set API_KEY=supersecretvalue first.")).rejects.toThrow(
      "That edit looks like it contains a secret, so it was not saved.",
    );
    expect(writes(store)).toEqual([]);
  });

  it("an edit already in the file is cleared by accepting it, not added again", async () => {
    const store = fakeLearnStore();
    await stageRetroEdits([edit("Keep the line short.")], AT);
    const [first] = parseRetroState(store.state).staged;
    await acceptStaged(first.id);
    const saved = store.opinions;
    store.state = { retro: { staged: [first], declined: [] } };
    await expect(acceptStaged(first.id)).resolves.toBe(true);
    expect(store.opinions).toBe(saved);
    expect(parseRetroState(store.state).staged).toEqual([]);
  });
});
