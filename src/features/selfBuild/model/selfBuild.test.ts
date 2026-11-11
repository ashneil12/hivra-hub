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
  const souls = new Map<string, string>();
  archive.setMonoArchive({
    archive: async (id, stamp) => `${id}-${stamp}`,
    restore: async () => undefined,
  });
  return {
    mono,
    changes: await import("../../hub/model/botChanges"),
    flow: await import("./changeFlow"),
    make: await import("./monoMake"),
    said: await import("./ashSaid"),
    souls,
    deps: {
      createMono: (projects: string[]) => mono.createMono(projects),
      name: mono.saveMonoName,
      engine: (id: string, engine: string) =>
        void mono.updateMono(id, (m) => ({ ...m, engine })),
      writeSoul: async (id: string, soul: string) => void souls.set(id, soul),
      setConnectors: async () => undefined,
      addToRoom: () => undefined,
      discard: (id: string) => mono.discardNewMono(id),
    },
  };
}

const ME = {
  monoId: "ada",
  name: "Chief of Staff",
  projects: ["/Users/ash/Projects/hivra"],
};

it("refuses a draft named Chief of Staff, including one folded with an invisible character", async () => {
  const a = await app();
  const fields = {
    role: "Runs the day",
    who: "I keep the list.",
    watchFor: "A decision with no owner.",
  };
  expect(() => a.make.draftMono({ name: "Chief of Staff", ...fields }, ME, 1000)).toThrow(/Chief of Staff/);
  expect(() => a.make.draftMono({ name: "Chief​ of Staff", ...fields }, ME, 1001)).toThrow(/Chief of Staff/);
  expect(a.mono.listMonos().some((mono) => mono.name === "Chief of Staff")).toBe(false);
});

it("a drafted Mono is made only after Ash answers, once, with its role and an Undo row", async () => {
  const a = await app();
  const draft = a.make.draftMono(
    {
      name: "Scout",
      role: "Finds sign-up leads",
      who: "I'm Scout. I find people worth a follow-up.",
      watchFor: "People who signed up and never came back.",
    },
    ME,
    1000,
  );
  expect(draft.plan).toMatchObject({
    name: "Scout",
    role: "Finds sign-up leads",
  });
  expect(a.mono.listMonos().some((m) => m.name === "Scout")).toBe(false);
  // The draft card shows the creature it will get, picked now.
  const card = a.make.waitingDrafts().find((d) => d.id === draft.draftId)!;
  expect(card.look?.mascot).toBeTruthy();

  let spoke = false;
  const host = {
    ashSpokeSince: () => spoke,
    room: () => ({ id: "r", name: "r" }),
    deps: a.deps as never,
  };
  await expect(a.make.makeDrafted(draft.draftId, ME, host)).rejects.toThrow(
    /hasn't answered/,
  );
  expect(a.mono.listMonos().some((m) => m.name === "Scout")).toBe(false);

  spoke = true;
  const made = await a.make.makeDrafted(draft.draftId, ME, host);
  const scout = a.mono.findMono(made.monoId)!;
  expect({ mascot: scout.mascot, color: scout.color }).toEqual(card.look);
  expect(a.make.waitingDrafts().some((d) => d.id === draft.draftId)).toBe(
    false,
  );
  expect(a.mono.monoRole(scout)).toBe("Finds sign-up leads");
  // The same draft never makes a second one.
  expect(await a.make.makeDrafted(draft.draftId, ME, host)).toMatchObject({
    alreadyMade: true,
    monoId: made.monoId,
  });
  expect(a.mono.listMonos().filter((m) => m.name === "Scout")).toHaveLength(1);

  const row = a.changes
    .botChangesSince(0)
    .find((c) => c.made?.monoId === made.monoId)!;
  expect(row.bot).toBe("Chief of Staff");
  await a.changes.undoBotChange([row.id]);
  expect(a.mono.findMono(made.monoId)).toBeUndefined();
  await a.changes.redoBotChange([row.id]);
  expect(a.mono.findMono(made.monoId)?.name).toBe("Scout");
});

it("Ash's yes counts only when he typed it after the draft, in its chat or a room it shares", async () => {
  const a = await app();
  const session = {
    blocks: [
      { role: "user", text: "yes", sentAt: 500 },
      { role: "user", text: "[MonoCode note] x", sentAt: 2000 },
    ],
  } as never;
  expect(a.said.ashSpokeSince(session, "scout", 1000, [])).toBe(false);
  const room = {
    memberIds: ["scout"],
    conversations: [{ messages: [{ from: "ash", at: 1500 }] }],
  } as never;
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
      return [
        { title: "New chat button at the top", data: "button" },
        { title: "Accent a bit more purple", data: "accent" },
      ];
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
  a.flow.offerChange({
    id: "c1",
    kind: "test",
    title: "Button and accent",
    by: "Chief of Staff",
    data: {},
  });
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
  a.flow.offerChange({
    id: "c2",
    kind: "test",
    title: "Bigger chat text",
    by: "Chief of Staff",
    data: {},
  });
  expect(await a.flow.applyOffered("c2")).toBe(
    "That touches settings, which bots can't change.",
  );
  expect(a.flow.offeredChanges()[0].problem).toMatch(/settings/);
  await a.flow.showPreview("c2", true);
  expect(await a.flow.discardOffered("c2")).toBeUndefined();
  expect(previews).toEqual([true, false]);
  expect(a.flow.offeredChanges()).toEqual([]);
  expect(a.changes.flowChanges("test")).toEqual([]);
  expect(applied).toBe(1);
});

it("a drafted soul is the short shape: Role, Who I am, What I watch for, Skills, and no How-I-talk or tone section", async () => {
  const a = await app();
  const host = {
    ashSpokeSince: () => true,
    room: () => ({ id: "r", name: "r" }),
    deps: a.deps as never,
  };
  const draft = a.make.draftMono(
    {
      name: "Postie",
      role: "X posts",
      who: "I'm Postie. I turn shipped work into X posts.",
      watchFor:
        "Threads worth posting, and anything that shouldn't be public yet.",
      skills: ["threads"],
    },
    ME,
    1000,
  );
  const made = await a.make.makeDrafted(draft.draftId, ME, host);
  const soul = a.souls.get(made.monoId)!;
  expect([...soul.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1])).toEqual([
    "Role",
    "Who I am",
    "What I watch for",
    "Skills",
  ]);
  expect(soul).toContain("## What I watch for\nThreads worth posting");
  expect(draft.plan.watchFor).toBe(
    "Threads worth posting, and anything that shouldn't be public yet.",
  );
  expect(soul).not.toMatch(/how i talk|tone|format|voice/i);
  expect(soul).toContain("## Role\nX posts");
  expect(soul).toContain("- threads");

  // A soul handed in with How I talk or tone rules is turned down in plain words, and nothing is drafted.
  for (const extra of [
    "## How I talk\nShort and warm.",
    "## Tone rules\nNo emoji.",
  ])
    expect(() =>
      a.make.draftMono(
        {
          name: "Chatty",
          soul: `# Soul\n\n## Role\nChats\n\n## Who I am\nI'm Chatty.\n\n## What I watch for\nQuiet rooms.\n\n${extra}\n`,
        },
        ME,
        2000,
      ),
    ).toThrow(/short shape/);
  // The refusal says where Ash's own words on how it sounds go (AD13 run f451: "keep the casual" was dropped twice).
  expect(() =>
    a.make.draftMono(
      { name: "Chatty", soul: "# Soul\n\n## Role\nChats\n\n## Who I am\nI'm Chatty.\n\n## What I watch for\nQuiet rooms.\n\n## Tone\nCasual.\n" },
      ME,
      2100,
    ),
  ).toThrow(/If Ash said how it should sound, put his words in ## Who I am/);
  // ...and a who that carries them is drafted as is.
  const casual = a.make.draftMono(
    { name: "Breezy", role: "X posts", who: "I'm Breezy. Ash said the posts are casual.", watchFor: "Product news." },
    ME,
    2200,
  );
  expect(JSON.stringify(casual)).toContain("Ash said the posts are casual.");
  // Without what it watches for, it isn't drafted.
  expect(() =>
    a.make.draftMono(
      { name: "Vague", role: "Helps", who: "I'm Vague." },
      ME,
      2500,
    ),
  ).toThrow(/watchFor/);
  // A soul in the short shape is kept to it, with the given skills added.
  const kept = a.make.draftMono(
    {
      name: "Tidy",
      soul: "# Soul\n\n## Role\nTidies\n\n## Who I am\nI'm Tidy.\n\n## What I watch for\nMess.\n\n## Skills\n- sweep\n",
      skills: ["dust"],
    },
    ME,
    3000,
  );
  expect(kept.plan).toMatchObject({
    role: "Tidies",
    soul: "I'm Tidy.",
    watchFor: "Mess.",
    skills: ["sweep", "dust"],
  });
});

it("a draft lists only skills that are installed; a made-up one is refused with the real ones", async () => {
  const a = await app();
  const known = new Set(["hub-ui-check", "proactive-skill-capture"]);
  const base = {
    role: "X posts",
    who: "I'm Postie.",
    watchFor: "Threads worth posting.",
  };
  expect(() =>
    a.make.draftMono(
      { name: "Postie", ...base, skills: ["x-threads"] },
      ME,
      1000,
      known,
    ),
  ).toThrow(
    /No skill called x-threads is installed.*hub-ui-check, proactive-skill-capture/,
  );
  expect(
    a.make.draftMono(
      { name: "Postie", ...base, skills: ["hub-ui-check"] },
      ME,
      1000,
      known,
    ).plan.skills,
  ).toEqual(["hub-ui-check"]);
});

it("Dr Eggbot style: a draft waits until the Mono asked Ash a question and he answered", async () => {
  const a = await app();
  const block = (role: string, text: string) => ({ id: text, role, text });
  const chat = (...blocks: { id: string; role: string; text: string }[]) =>
    ({ blocks }) as never;
  expect(
    a.said.askedAshAndHeardBack(
      chat(block("user", "make me a mono for x posts")),
      "cos",
      [],
    ),
  ).toBe(false);
  expect(
    a.said.askedAshAndHeardBack(
      chat(
        block("user", "make me a mono"),
        block("assistant", "Should it post on its own, or draft for your OK?"),
      ),
      "cos",
      [],
    ),
  ).toBe(false);
  expect(
    a.said.askedAshAndHeardBack(
      chat(
        block("user", "make me a mono"),
        block("assistant", "Should it post on its own, or draft for your OK?"),
        block("user", "draft for my ok"),
      ),
      "cos",
      [],
    ),
  ).toBe(true);
  // An app note isn't Ash answering.
  expect(
    a.said.askedAshAndHeardBack(
      chat(
        block("assistant", "Who does it answer to?"),
        block("user", "[MonoCode report] done"),
      ),
      "cos",
      [],
    ),
  ).toBe(false);
});

it("in a room, Ash writing back after the seat's post counts as heard back; his first ask alone never does", async () => {
  const a = await app();
  const chat = () => ({ blocks: [] }) as never;
  const room = (messages: Array<{ from: string; text: string }>) =>
    [{ id: "tally:leadership", memberIds: ["cos", "cam"], conversations: [{ id: "c1", messages }] }] as never;
  expect(a.said.askedAshAndHeardBack(chat(), "cos", room([{ from: "ash", text: "add a new mono for x posts" }]))).toBe(false);
  expect(
    a.said.askedAshAndHeardBack(chat(), "cos", room([
      { from: "ash", text: "add a new mono for x posts" },
      { from: "cos", text: "The X Mono is not made yet. It answers to me." },
    ])),
  ).toBe(false);
  expect(
    a.said.askedAshAndHeardBack(chat(), "cos", room([
      { from: "ash", text: "add a new mono for x posts" },
      { from: "cos", text: "The X Mono is not made yet. It answers to me." },
      { from: "ash", text: "ye drafts only, it answers to cos" },
    ])),
  ).toBe(true);
  // Another seat's question that Ash answers counts too; a seat the Mono isn't in never does.
  expect(
    a.said.askedAshAndHeardBack(chat(), "cos", room([
      { from: "ash", text: "add a new mono for x posts" },
      { from: "cam", text: "Who does it answer to?" },
      { from: "ash", text: "cos" },
    ])),
  ).toBe(true);
  expect(
    a.said.askedAshAndHeardBack(chat(), "pm", room([
      { from: "cos", text: "Who does it answer to?" },
      { from: "ash", text: "cos" },
    ])),
  ).toBe(false);
});

it("Not this one on the draft card hides it and makes nothing", async () => {
  const a = await app();
  const draft = a.make.draftMono(
    { name: "Nope", role: "Says no", who: "I am Nope.", watchFor: "Nothing." },
    ME,
    2000,
  );
  a.make.dismissDraft(draft.draftId);
  expect(a.make.waitingDrafts().some((d) => d.id === draft.draftId)).toBe(
    false,
  );
  expect(a.mono.listMonos().some((m) => m.name === "Nope")).toBe(false);
});

it("the draft card speaks to Ash as you; the saved soul keeps his name", async () => {
  const a = await app();
  const draft = a.make.draftMono({ name: "Postie", role: "Drafts posts for Ash's OK", who: "I'm Postie. I draft each post for Ash's OK and show Ash the list.", watchFor: "Anything that needs Ash's eyes first." }, ME, 3000);
  const d = a.make.waitingDrafts().find((x) => x.id === draft.draftId)!;
  expect(a.make.draftCard(d)).toMatchObject({ who: "I'm Postie. I draft each post for your OK and show you the list.", watchFor: "Anything that needs your eyes first." });
  expect(a.make.toAsh(d.role!)).toBe("Drafts posts for your OK");
  expect(d.soul).toContain("Ash's OK");
});
