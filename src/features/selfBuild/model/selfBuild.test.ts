// @vitest-environment happy-dom
// ash-day steps 13 and 15's shared half: a Mono is made only after Ash answers its draft (with Undo in Bot changes),
// and an offered change applies part by part, so one part can be undone without the other.
import { beforeEach, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function app() {
  const mono = await import("../../monos/model/mono");
  const archive = await import("../../monos/model/monoArchive");
  archive.setMonoArchive({ archive: async (id, stamp) => `${id}-${stamp}`, restore: async () => undefined });
  return {
    mono,
    changes: await import("../../hub/model/botChanges"),
    flow: await import("./changeFlow"),
    make: await import("./monoMake"),
    said: await import("./ashSaid"),
    deps: {
      createMono: (projects: string[]) => mono.createMono(projects),
      name: mono.saveMonoName,
      engine: (id: string, engine: string) => void mono.updateMono(id, (m) => ({ ...m, engine })),
      writeSoul: async () => undefined,
      setConnectors: async () => undefined,
      addToRoom: () => undefined,
      discard: (id: string) => mono.discardNewMono(id),
    },
  };
}

const ME = { monoId: "chief-of-staff", name: "Chief of Staff", projects: ["/Users/ash/Projects/hivra"] };

it("a drafted Mono is made only after Ash answers, once, with its role and an Undo row", async () => {
  const a = await app();
  const draft = a.make.draftMono({ name: "Scout", role: "Finds sign-up leads", soul: "# Scout\n\n## Role\nFinds sign-up leads\n" }, ME, 1000);
  expect(draft.plan).toMatchObject({ name: "Scout", role: "Finds sign-up leads" });
  expect(a.mono.listMonos().some((m) => m.name === "Scout")).toBe(false);

  let spoke = false;
  const host = { ashSpokeSince: () => spoke, room: () => ({ id: "r", name: "r" }), deps: a.deps as never };
  await expect(a.make.makeDrafted(draft.draftId, ME, host)).rejects.toThrow(/hasn't answered/);
  expect(a.mono.listMonos().some((m) => m.name === "Scout")).toBe(false);

  spoke = true;
  const made = await a.make.makeDrafted(draft.draftId, ME, host);
  const scout = a.mono.findMono(made.monoId)!;
  expect(a.mono.monoRole(scout)).toBe("Finds sign-up leads");
  // The same draft never makes a second one.
  expect(await a.make.makeDrafted(draft.draftId, ME, host)).toMatchObject({ alreadyMade: true, monoId: made.monoId });
  expect(a.mono.listMonos().filter((m) => m.name === "Scout")).toHaveLength(1);

  const row = a.changes.botChangesSince(0).find((c) => c.made?.monoId === made.monoId)!;
  expect(row.bot).toBe("Chief of Staff");
  await a.changes.undoBotChange([row.id]);
  expect(a.mono.findMono(made.monoId)).toBeUndefined();
  await a.changes.redoBotChange([row.id]);
  expect(a.mono.findMono(made.monoId)?.name).toBe("Scout");
});

it("Ash's yes counts only when he typed it after the draft, in its chat or a room it shares", async () => {
  const a = await app();
  const session = { blocks: [{ role: "user", text: "yes", sentAt: 500 }, { role: "user", text: "[MonoCode note] x", sentAt: 2000 }] } as never;
  expect(a.said.ashSpokeSince(session, "scout", 1000, [])).toBe(false);
  const room = { memberIds: ["scout"], conversations: [{ messages: [{ from: "ash", at: 1500 }] }] } as never;
  expect(a.said.ashSpokeSince(session, "scout", 1000, [room])).toBe(true);
  expect(a.said.ashSpokeSince(session, "other", 1000, [room])).toBe(false);
});

it("an applied change lands one Bot changes row per part, and undoing one leaves the other", async () => {
  const a = await app();
  const state = { button: "bottom", accent: "blue" };
  const previews: boolean[] = [];
  a.flow.registerChangeKind("test", {
    preview: async (_d, on) => void previews.push(on),
    apply: async () => {
      state.button = "top";
      state.accent = "purple";
      return [{ title: "New chat button at the top", data: "button" }, { title: "Accent a bit more purple", data: "accent" }];
    },
    undo: async (part) => {
      if (part === "accent") state.accent = "blue";
      else state.button = "bottom";
      return null;
    },
    redo: async (part) => {
      if (part === "accent") state.accent = "purple";
      else state.button = "top";
    },
  });
  a.flow.offerChange({ id: "c1", kind: "test", title: "Button and accent", by: "Chief of Staff", data: {} });
  expect(await a.flow.showPreview("c1", true)).toBeUndefined();
  expect(previews).toEqual([true]);
  expect(await a.flow.applyOffered("c1")).toBeUndefined();
  expect(a.flow.offeredChanges()).toEqual([]);
  const rows = a.changes.flowChanges("test");
  expect(rows).toHaveLength(2);
  const colour = rows.find((r) => r.flow?.data === "accent")!;
  await a.changes.undoBotChange([colour.id]);
  expect(state).toEqual({ button: "top", accent: "blue" });
  await a.changes.redoBotChange([colour.id]);
  expect(state).toEqual({ button: "top", accent: "purple" });
});

it("Discard takes the preview back out and changes nothing; a refused apply keeps the offer with Ash's reason", async () => {
  const a = await app();
  const previews: boolean[] = [];
  let applied = 0;
  a.flow.registerChangeKind("test", {
    preview: async (_d, on) => void previews.push(on),
    apply: async () => {
      applied++;
      throw new Error("That touches settings, which bots can't change.");
    },
    discard: async () => undefined,
    undo: async () => null,
    redo: async () => undefined,
  });
  a.flow.offerChange({ id: "c2", kind: "test", title: "Bigger chat text", by: "Chief of Staff", data: {} });
  expect(await a.flow.applyOffered("c2")).toBe("That touches settings, which bots can't change.");
  expect(a.flow.offeredChanges()[0].problem).toMatch(/settings/);
  await a.flow.showPreview("c2", true);
  expect(await a.flow.discardOffered("c2")).toBeUndefined();
  expect(previews).toEqual([true, false]);
  expect(a.flow.offeredChanges()).toEqual([]);
  expect(a.changes.flowChanges("test")).toEqual([]);
  expect(applied).toBe(1);
});
