// @vitest-environment happy-dom
// r66 (Alfred's 0.16.5 A-rows): a retired Mono's connectors entry leaves with it and stays gone (A10), Chief of Staff
// reads the live Mono list every turn (A6), retires a Mono from the chat only on Ash's yes, with Undo (A10), and keeps
// the top slot by id, not name (A3).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

type View = import("./hubConnectors").ConnectorsView;

function fakeRust() {
  const view: View = {
    settings: { composio: false, googleClient: false, connectors: {}, monos: {} },
    launcher: "/x/monocode",
    subcommand: "connector-run",
    kind: "dev",
  };
  const backend = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "connector_set_mono") {
      const choice = args?.choice as View["settings"]["monos"][string] | null;
      if (choice) view.settings.monos[args?.monoId as string] = choice;
      else delete view.settings.monos[args?.monoId as string];
    } else if (command !== "connectors_state") throw new Error(`unexpected ${command}`);
    return structuredClone(view) as T;
  };
  return { view, backend };
}

function roster(monos: { id: string; name: string; role?: string }[]) {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify(monos.map((m) => ({ mascot: "robot", color: "hsl(0 0% 50%)", projects: [], ...m }))),
  );
}

async function setUp() {
  roster([
    { id: "chief-of-staff", name: "Chief of Staff", role: "Runs the team" },
    { id: "pm", name: "PM", role: "Plans" },
    { id: "postie", name: "Postie", role: "X posts" },
  ]);
  const rust = fakeRust();
  rust.view.settings.monos.postie = { mode: "only", ids: ["github"] };
  const c = await import("./hubConnectors");
  c.setConnectorsBackend(rust.backend);
  await c.loadConnectors();
  const archive = await import("../../monos/model/monoArchive");
  archive.setMonoArchive({ archive: async (id, stamp) => `${id}-${stamp}`, restore: async () => undefined });
  return { rust, c, archive };
}

describe("a retired Mono's connectors entry", () => {
  it("is removed with it, stays removed across a reread, and comes back only with Undo of that retire", async () => {
    const { rust, c, archive } = await setUp();
    const retired = await archive.retireMono("postie");
    expect(retired?.connectors).toEqual({ mode: "only", ids: ["github"] });
    expect(rust.view.settings.monos.postie).toBeUndefined();
    expect(c.retiredMonoIds()).toContain("postie");

    // Something else writes it back (an older Undo, a restart reading a stale file): the next read removes it again.
    rust.view.settings.monos.postie = { mode: "only", ids: ["github"] };
    await c.loadConnectors();
    await vi.waitFor(() => expect(rust.view.settings.monos.postie).toBeUndefined());

    await archive.restoreRetiredMono(retired!);
    expect(rust.view.settings.monos.postie).toEqual({ mode: "only", ids: ["github"] });
    expect(c.retiredMonoIds()).not.toContain("postie");
    await c.loadConnectors();
    expect(rust.view.settings.monos.postie).toEqual({ mode: "only", ids: ["github"] });
  });
});

describe("Chief of Staff's live Mono list", () => {
  it("is read fresh each turn, leaves retired Monos out, and is only for Chief of Staff", async () => {
    const { archive } = await setUp();
    const { liveMonosNote } = await import("./liveMonos");
    expect(liveMonosNote("chief-of-staff")).toContain("- Postie: X posts");
    expect(liveMonosNote("chief-of-staff")).toContain("- Chief of Staff (you)");
    await archive.retireMono("postie");
    const now = liveMonosNote("chief-of-staff")!;
    expect(now).not.toContain("Postie");
    expect(now).toMatch(/isn't listed was retired/);
    expect(liveMonosNote("pm")).toBeUndefined();
    expect(liveMonosNote(undefined)).toBeUndefined();
  });

  it("goes into a room turn's prompt only when set", async () => {
    const { turnPrompt } = await import("./roomTurns");
    const cos = { id: "chief-of-staff", name: "Chief of Staff", role: "Runs the team" };
    const base = { chatName: "Team", chatId: "c1", projectId: "hub", seats: [cos], host: cos, transcript: [], me: cos, kind: "answer" } as unknown as Parameters<typeof turnPrompt>[0];
    expect(turnPrompt(base)).not.toContain("<monos_now>");
    expect(turnPrompt({ ...base, monosNow: "<monos_now>\n- PM\n</monos_now>" })).toContain("<monos_now>");
  });
});

describe("the Monos list's top slot", () => {
  it("keys on the id, so a renamed Chief of Staff stays first", async () => {
    const { hubMonoRank } = await import("./hubData");
    expect(hubMonoRank({ id: "chief-of-staff", name: "Boss" })).toBe(0);
    expect(hubMonoRank({ id: "someone", name: "Chief of Staff" })).toBe(0);
    expect(hubMonoRank({ id: "postie", name: "Postie" })).toBeGreaterThan(hubMonoRank({ id: "chief-of-staff", name: "Boss" }));
  });
});

describe("retiring a Mono from the chat", () => {
  const cos = { monoId: "chief-of-staff", name: "Chief of Staff" };

  it("names it first, retires it only after Ash speaks, with a Bot changes row whose Undo brings it back", async () => {
    const { rust } = await setUp();
    const { handleMonoRetire } = await import("../../selfBuild/model/monoRetire");
    const mono = await import("../../monos/model/mono");
    const changes = await import("./botChanges");
    let spoke = false;
    const host = { ashSpokeSince: () => spoke };

    const ask = (await handleMonoRetire({ mono: "postie" }, cos, host)) as { retireId: string; note: string };
    expect(ask.note).toMatch(/Nothing is retired yet/);
    expect(mono.findMono("postie")).toBeTruthy();
    await expect(handleMonoRetire({ retireId: ask.retireId }, cos, host)).rejects.toThrow(/hasn't answered/);
    expect(mono.findMono("postie")).toBeTruthy();

    spoke = true;
    const done = (await handleMonoRetire({ retireId: ask.retireId }, cos, host)) as { retired: string };
    expect(done.retired).toBe("Postie");
    expect(mono.findMono("postie")).toBeUndefined();
    expect(rust.view.settings.monos.postie).toBeUndefined();
    const row = changes.botChangesSince(0).find((c) => c.line === "Chief of Staff retired Postie");
    expect(row?.retired?.mono.id).toBe("postie");
    // Asking again is a no-op, not a second retire.
    expect(await handleMonoRetire({ retireId: ask.retireId }, cos, host)).toMatchObject({ alreadyRetired: true });

    await changes.undoBotChange([row!.id]);
    expect(mono.findMono("postie")).toBeTruthy();
    expect(rust.view.settings.monos.postie).toEqual({ mode: "only", ids: ["github"] });
  });

  it("is Chief of Staff's alone, never itself, and only Monos on the team now", async () => {
    await setUp();
    const { handleMonoRetire } = await import("../../selfBuild/model/monoRetire");
    const host = { ashSpokeSince: () => true };
    await expect(handleMonoRetire({ mono: "postie" }, { monoId: "pm", name: "PM" }, host)).rejects.toThrow(/Only Chief of Staff/);
    await expect(handleMonoRetire({ mono: "Chief of Staff" }, cos, host)).rejects.toThrow(/yourself/);
    await expect(handleMonoRetire({ mono: "Ghost" }, cos, host)).rejects.toThrow(/No Mono called "Ghost"/);
    await expect(handleMonoRetire({ retireId: "nope", mono: "x" }, cos, host)).rejects.toThrow(/send nothing else/);
  });
});
