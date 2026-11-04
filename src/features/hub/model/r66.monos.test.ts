// @vitest-environment happy-dom
// A retired Mono's connectors entry leaves with it. Any Mono's turn reads the live roster (retired Monos omitted).
// Retiring is any Mono's own chat, never itself, and only after the user has answered. No id stays first.
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
    { id: "mina", name: "Mina", role: "Writes" },
    { id: "jo", name: "Jo", role: "Reads" },
    { id: "postie", name: "Postie", role: "X posts" },
    { id: "checker", name: "Checker", role: "Reads the chats" },
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

describe("the live Mono list", () => {
  it("is read for any Mono, leaves retired Monos out, and is absent when there is no Mono", async () => {
    const { archive } = await setUp();
    const { liveMonosNote } = await import("./liveMonos");
    expect(liveMonosNote("mina")).toContain("- Postie: X posts");
    expect(liveMonosNote("mina")).toContain("- Mina (you)");
    expect(liveMonosNote("mina")).not.toContain("Checker");
    expect(liveMonosNote("jo")).toContain("- Jo (you)");
    expect(liveMonosNote("jo")).toContain("- Mina");
    await archive.retireMono("postie");
    const now = liveMonosNote("mina")!;
    expect(now).not.toContain("Postie");
    expect(now).toMatch(/isn't listed was retired/);
    expect(liveMonosNote("jo")).not.toContain("Postie");
    expect(liveMonosNote("jo")).toContain("- Jo (you)");
    expect(liveMonosNote(undefined)).toBeUndefined();
    expect(liveMonosNote("")).toBeUndefined();
  });

  it("goes into a room turn's prompt only when set", async () => {
    const { turnPrompt } = await import("./roomTurns");
    const mina = { id: "mina", name: "Mina", role: "Writes" };
    const base = { chatName: "Team", chatId: "c1", projectId: "hub", seats: [mina], host: mina, transcript: [], me: mina, kind: "answer" } as unknown as Parameters<typeof turnPrompt>[0];
    expect(turnPrompt(base)).not.toContain("<monos_now>");
    expect(turnPrompt({ ...base, monosNow: "<monos_now>\n- Jo\n</monos_now>" })).toContain("<monos_now>");
  });
});

describe("the Monos list's order", () => {
  it("does not keep a special id first: a lead ranks as a lead, and a renamed Mono does not", async () => {
    const { ensureProjectLeads } = await import("./hubLeads");
    const { hubMonoRank } = await import("./hubData");
    ensureProjectLeads([{ id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge", folder: "/p/hub" }]);
    expect(hubMonoRank({ id: "hub-lead", name: "Boss" })).toBe(10);
    expect(hubMonoRank({ id: "mina", name: "Boss" })).toBe(20);
    expect(hubMonoRank({ id: "mina", name: "Hub lead" })).toBe(20);
    expect(hubMonoRank({ id: "postie", name: "Postie" })).toBe(hubMonoRank({ id: "mina", name: "Boss" }));
    expect(hubMonoRank({ id: "postie", name: "Postie" })).toBeGreaterThan(hubMonoRank({ id: "hub-lead", name: "Boss" }));
  });
});

describe("retiring a Mono from the chat", () => {
  const jo = { monoId: "jo", name: "Jo" };

  it("names it first, retires it only after the user speaks, with a Bot changes row whose Undo brings it back", async () => {
    const { rust } = await setUp();
    const { handleMonoRetire } = await import("../../selfBuild/model/monoRetire");
    const mono = await import("../../monos/model/mono");
    const changes = await import("./botChanges");
    let spoke = false;
    const host = { ashSpokeSince: () => spoke };

    const ask = (await handleMonoRetire({ mono: "postie" }, jo, host)) as { retireId: string; note: string };
    expect(ask.note).toMatch(/Nothing is retired yet/);
    expect(mono.findMono("postie")).toBeTruthy();
    await expect(handleMonoRetire({ retireId: ask.retireId }, jo, host)).rejects.toThrow(/hasn't answered/);
    expect(mono.findMono("postie")).toBeTruthy();

    spoke = true;
    const done = (await handleMonoRetire({ retireId: ask.retireId }, jo, host)) as { retired: string };
    expect(done.retired).toBe("Postie");
    expect(mono.findMono("postie")).toBeUndefined();
    expect(rust.view.settings.monos.postie).toBeUndefined();
    const row = changes.botChangesSince(0).find((c) => c.line === "Jo retired Postie");
    expect(row?.retired?.mono.id).toBe("postie");
    expect(await handleMonoRetire({ retireId: ask.retireId }, jo, host)).toMatchObject({ alreadyRetired: true });

    await changes.undoBotChange([row!.id]);
    expect(mono.findMono("postie")).toBeTruthy();
    expect(rust.view.settings.monos.postie).toEqual({ mode: "only", ids: ["github"] });
  });

  it("is any Mono's own chat, never itself, and only Monos on the team now", async () => {
    await setUp();
    const { handleMonoRetire } = await import("../../selfBuild/model/monoRetire");
    const host = { ashSpokeSince: () => true };
    const mina = { monoId: "mina", name: "Mina" };
    const ask = await handleMonoRetire({ mono: "postie" }, mina, host);
    expect(ask).toMatchObject({ mono: "Postie" });
    await expect(handleMonoRetire({ mono: "postie" }, { monoId: "", name: "Nope" }, host)).rejects.toThrow(/Only a Mono's own chat/);
    await expect(handleMonoRetire({ mono: "Jo" }, jo, host)).rejects.toThrow(/yourself/);
    await expect(handleMonoRetire({ mono: "Ghost" }, jo, host)).rejects.toThrow(/No Mono called "Ghost"/);
    await expect(handleMonoRetire({ retireId: "nope", mono: "x" }, jo, host)).rejects.toThrow(/send nothing else/);
  });
});
