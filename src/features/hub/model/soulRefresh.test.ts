// @vitest-environment happy-dom
// Soul refresh, applied on its own (decided 20 Oct; Ash's 14 Oct rule: bigger bot changes apply themselves, land in Bot
// changes with Undo and never wait for a click). Ash's hand edits win, the row says in plain words what changes for the
// Mono and what was skipped, and the whole old soul is saved first. The Mono files are a stand-in for the Rust
// mono_read / mono_save commands (hash-checked, like mono.rs).
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { botChangeRows, findBotChange, redoBotChange, setBotFiles, undoBotChange } from "./botChanges";
import { LIVE_15_OCT_LEAD_SOULS } from "./testdata/leadSouls15Oct";
import {
  folderInSoul,
  isKnownSeededSoul,
  matchSeededSoul,
  planSoulRefresh,
  refreshSouls,
  SECTION_SENTENCES,
  soulSections,
  soulTemplates,
  SOUL_TEMPLATE_FILE,
  templateFingerprint,
} from "./soulRefresh";
import type { AgentFilePath } from "../../monos/model/monoFiles";
import { TEAM_SOULS } from "./teamSouls";
import { CHECKER_SOUL } from "./hubChecker";
import { leadSoul } from "./hubLeads";
import { defaultSoul } from "../../monos/model/monoFiles";

function fakeFiles() {
  const files = new Map<string, string>();
  const key = (id: string, path: string) => `${id}/${path}`;
  const hash = (text: string | undefined) => `h:${text ?? ""}`;
  const api = {
    files,
    get: (id: string, path: string) => files.get(key(id, path)),
    set: (id: string, path: string, text: string) => files.set(key(id, path), text),
    read: async (id: string, path: AgentFilePath) => ({ text: files.get(key(id, path)) ?? null, hash: hash(files.get(key(id, path))) }),
    write: async (id: string, path: AgentFilePath, text: string, expected?: string) => {
      if (expected !== undefined && hash(files.get(key(id, path))) !== expected) throw "conflict";
      files.set(key(id, path), text);
      return hash(text);
    },
  };
  setBotFiles({ read: api.read, write: api.write });
  return api;
}

const OLD_LEAD = `# Soul

## Standing instructions
You are Hivra lead, the lead for Hivra, working in /Users/ash/Projects/Hivra.

## Your job
- You are mainly an orchestrator.
- Ask Ash with ash_ask_ash.
`;
const NEW_LEAD = `# Soul

## Standing instructions
You are Hivra lead, the lead for Hivra, working in /Users/ash/Projects/Hivra.

## Your job
- You are mainly an orchestrator.
- You talk to Chief of Staff, and to Ash only when routed.

## How you run the project
- Start-ack: your first reply cites the brief.
- Your workers ask you, not Ash.

## Skills
- review-pr
`;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
});

const DAY = new Date(2026, 9, 21, 9, 0);
const NOTE = "memory/soul-before-refresh-2026-10-21.md";
/** No diff, no path, no id, no markdown in what Ash reads (design brief rule 14). */
function expectPlain(text: string) {
  expect(text).not.toMatch(/\/|\.md\b|##|^[-+] |`|soul-refresh:|hivra-lead/m);
}

describe("planSoulRefresh", () => {
  it("splits a soul by its ## sections", () => {
    expect(soulSections(NEW_LEAD).map((s) => s.key)).toEqual(["", "## Standing instructions", "## Your job", "## How you run the project", "## Skills"]);
  });

  it("knows a soul already on its template", () => {
    expect(planSoulRefresh(NEW_LEAD, NEW_LEAD).kind).toBe("current");
  });

  it("with a recorded template: updates what Ash left alone and keeps what he rewrote", () => {
    const edited = OLD_LEAD.replace("- Ask Ash with ash_ask_ash.", "- Ask Ash with ash_ask_ash.\n- Ash: never touch the token page.");
    const plan = planSoulRefresh(edited, NEW_LEAD, OLD_LEAD);
    expect(plan.kind).toBe("apply");
    if (plan.kind !== "apply") return;
    expect(plan.knownBaseline).toBe(true);
    expect(plan.skipped).toEqual(["## Your job"]);
    expect(plan.added).toEqual(["## How you run the project", "## Skills"]);
    expect(plan.after).toContain("- Ash: never touch the token page.");
    expect(plan.after).toContain("Start-ack");
  });

  it("respects a section Ash deleted and keeps one he added; drops one the template dropped that he never touched", () => {
    const seed = `${NEW_LEAD}\n## Old habit\n- do the old thing\n`;
    const mine = `${seed.replace(/## How you run the project[\s\S]*?(?=## Skills)/, "")}\n## Mine\n- my own rule\n`;
    const template = NEW_LEAD.replace("- Start-ack: your first reply cites the brief.", "- Start-ack: cite the brief and what started.");
    const plan = planSoulRefresh(mine, template, seed);
    if (plan.kind !== "apply") throw new Error(plan.kind);
    expect(plan.after).not.toContain("How you run the project");
    expect(plan.after).toContain("## Mine\n- my own rule");
    expect(plan.after).not.toContain("Old habit");
    expect(plan.dropped).toEqual(["## Old habit"]);
    // He deleted a section the template then changed: it stays deleted, and that update counts as skipped.
    expect(plan.skipped).toEqual(["## How you run the project"]);
  });

  it("keeps the skills a Mono picked up and adds new template skills", () => {
    const mine = NEW_LEAD.replace("- review-pr", "- review-pr\n- hivra-release");
    const template = NEW_LEAD.replace("- review-pr", "- review-pr\n- human-writing");
    const plan = planSoulRefresh(mine, template, NEW_LEAD);
    if (plan.kind !== "apply") throw new Error(plan.kind);
    expect(plan.after).toContain("- review-pr\n- hivra-release\n- human-writing");
  });

  it("changes nothing when every changed section is one Ash rewrote", () => {
    const template = NEW_LEAD.replace("- You are mainly an orchestrator.", "- You orchestrate.");
    const mine = NEW_LEAD.replace("- You are mainly an orchestrator.", "- Ash's own words here.");
    expect(planSoulRefresh(mine, template, NEW_LEAD).kind).toBe("nothing-to-change");
  });
});

describe("refreshSouls: a soul behind its template is refreshed on its own, with Undo", () => {
  const templates = [{ monoId: "hivra-lead", name: "Hivra lead", template: NEW_LEAD }];

  it("refreshes a soul behind its template without a click, saves the old soul first, and Undo / Redo work", async () => {
    const f = fakeFiles();
    f.set("hivra-lead", "SOUL.md", OLD_LEAD);
    f.set("hivra-lead", SOUL_TEMPLATE_FILE, OLD_LEAD);
    expect(await refreshSouls(f, templates, DAY)).toEqual({ refreshed: ["hivra-lead"], recorded: [], skipped: [] });
    // Applied there and then.
    expect(f.get("hivra-lead", "SOUL.md")).toContain("Your workers ask you, not Ash.");
    expect(f.get("hivra-lead", SOUL_TEMPLATE_FILE)).toBe(NEW_LEAD);
    // The whole old soul is kept in its memory.
    expect(f.get("hivra-lead", NOTE)).toBe(OLD_LEAD);

    const row = botChangeRows().find((r) => r.kind === "one" && r.change.monoId === "hivra-lead");
    if (row?.kind !== "one") throw new Error("no row");
    const c = row.change;
    expect(c.day).toBe("Today");
    expect(c.undone).toBeFalsy();
    // One plain sentence per section that changed.
    expect(c.details).toEqual([
      "Hivra lead will now act as an orchestrator: small things itself, bigger pieces to workers with Ash's own words, and it talks to Chief of Staff rather than Ash unless the work is routed to him.",
      "Hivra lead will now confirm when work has really started, keep anything stuck visible with the reason, and ask Ash only from its own chat when it can't go on without him.",
      "Hivra lead picks up the app's newer skills and keeps the ones it learned.",
    ]);
    expect(c.line).toBe(`${c.details![0]} (and 2 more)`);
    for (const text of [c.line, c.now, c.after, ...c.details!]) expectPlain(text);

    await undoBotChange([c.id]);
    expect(f.get("hivra-lead", "SOUL.md")).toBe(OLD_LEAD);
    expect(findBotChange(c.id)?.undone).toBe(true);
    // Undone stays undone: the next pass doesn't make it again.
    expect((await refreshSouls(f, templates, DAY)).refreshed).toEqual([]);
    expect(f.get("hivra-lead", "SOUL.md")).toBe(OLD_LEAD);

    await redoBotChange([c.id]);
    expect(f.get("hivra-lead", "SOUL.md")).toContain("Your workers ask you, not Ash.");
  });

  it("Ash's edit wins: a section he rewrote keeps his words, and the row says plainly that the update was skipped", async () => {
    const f = fakeFiles();
    const mine = NEW_LEAD.replace("- You are mainly an orchestrator.", "- Ash: ask me before handing anything to the EXO team.");
    f.set("lead-b", "SOUL.md", mine);
    f.set("lead-b", SOUL_TEMPLATE_FILE, NEW_LEAD);
    const newer = NEW_LEAD.replace("- You are mainly an orchestrator.", "- You orchestrate.").replace(
      "- Your workers ask you, not Ash.",
      "- Your workers ask you, not Ash.\n- Ask before handing work to Ash.",
    );
    expect((await refreshSouls(f, [{ ...templates[0], monoId: "lead-b", template: newer }], DAY)).refreshed).toEqual(["lead-b"]);
    const soul = f.get("lead-b", "SOUL.md")!;
    expect(soul).toContain("- Ash: ask me before handing anything to the EXO team.");
    expect(soul).not.toContain("- You orchestrate.");
    expect(soul).toContain("- Ask before handing work to Ash.");
    expect(f.get("lead-b", NOTE)).toBe(mine);
    const c = findBotChange(`soul-refresh:lead-b:${templateFingerprint(newer)}`)!;
    expect(c.line).toBe(
      "Hivra lead will now confirm when work has really started, keep anything stuck visible with the reason, and ask Ash only from its own chat when it can't go on without him.",
    );
    expect(c.details).toEqual([
      c.line,
      "You had changed Hivra lead's “Your job” part yourself, so your version stays and the app's update to it was skipped.",
    ]);
    for (const text of c.details!) expectPlain(text);
  });

  it("records the template for a soul already on it, and changes nothing", async () => {
    const f = fakeFiles();
    f.set("lead-c", "SOUL.md", NEW_LEAD);
    expect(await refreshSouls(f, [{ ...templates[0], monoId: "lead-c" }], DAY)).toEqual({ refreshed: [], recorded: ["lead-c"], skipped: [] });
    expect(f.get("lead-c", SOUL_TEMPLATE_FILE)).toBe(NEW_LEAD);
    expect(await refreshSouls(f, [{ ...templates[0], monoId: "lead-c" }], DAY)).toEqual({ refreshed: [], recorded: [], skipped: [] });
    expect(botChangeRows().some((r) => r.kind === "one" && r.change.monoId === "lead-c")).toBe(false);
  });

  it("a later template refreshes again, keeping each old soul in its own note", async () => {
    const f = fakeFiles();
    f.set("lead-d", "SOUL.md", OLD_LEAD);
    f.set("lead-d", SOUL_TEMPLATE_FILE, OLD_LEAD);
    await refreshSouls(f, [{ ...templates[0], monoId: "lead-d" }], DAY);
    const first = f.get("lead-d", "SOUL.md")!;
    const newer = [{ ...templates[0], monoId: "lead-d", template: NEW_LEAD.replace("- Start-ack: your first reply cites the brief.", "- Start-ack: cite the brief and what started.") }];
    expect((await refreshSouls(f, newer, DAY)).refreshed).toEqual(["lead-d"]);
    expect(f.get("lead-d", "SOUL.md")).toContain("cite the brief and what started");
    expect(f.get("lead-d", NOTE)).toBe(OLD_LEAD);
    expect(f.get("lead-d", `memory/soul-before-refresh-2026-10-21-${templateFingerprint(newer[0].template)}.md`)).toBe(first);
  });

  it("leaves a soul Ash saved meanwhile alone (nothing recorded), and takes it up on the next pass", async () => {
    const f = fakeFiles();
    f.set("lead-e", "SOUL.md", OLD_LEAD);
    f.set("lead-e", SOUL_TEMPLATE_FILE, OLD_LEAD);
    const realWrite = f.write;
    let raced = false;
    const racing = {
      read: f.read,
      write: async (id: string, path: AgentFilePath, text: string, expected?: string) => {
        if (path === "SOUL.md" && !raced) {
          raced = true;
          f.set(id, "SOUL.md", `${OLD_LEAD}- Ash typed this a minute ago\n`);
        }
        return realWrite(id, path, text, expected);
      },
    };
    expect((await refreshSouls(racing, [{ ...templates[0], monoId: "lead-e" }], DAY)).refreshed).toEqual([]);
    expect(f.get("lead-e", "SOUL.md")).toContain("Ash typed this a minute ago");
    expect(botChangeRows().some((r) => r.kind === "one" && r.change.monoId === "lead-e")).toBe(false);
    // Next pass: refreshed over his new text, and his line is in the saved old soul.
    expect((await refreshSouls(f, [{ ...templates[0], monoId: "lead-e" }], DAY)).refreshed).toEqual(["lead-e"]);
    const notes = [...f.files.entries()].filter(([k]) => k.startsWith("lead-e/memory/")).map(([, v]) => v);
    expect(notes.some((n) => n.includes("Ash typed this a minute ago"))).toBe(true);
  });

  it("skips a Mono that hasn't been seeded yet", async () => {
    const f = fakeFiles();
    expect(await refreshSouls(f, templates, DAY)).toEqual({ refreshed: [], recorded: [], skipped: [] });
  });
});

describe("refreshSouls with no recorded template: only a soul the app itself seeded is swapped", () => {
  localStorage.setItem("monocode:hub-team-pack", "ash"); // the templates below are built at collection, on Ash's install
  const hivra = LIVE_15_OCT_LEAD_SOULS[0];
  const lead = { id: "hivra-lead", name: "Hivra lead", projectName: "Hivra", projectId: "hivra" } as Parameters<typeof leadSoul>[0];
  const template = defaultSoul(leadSoul(lead, hivra.values.folder));
  const hivraTemplate = [{ monoId: "hivra-lead", name: "Hivra lead", template, values: hivra.values }];

  it("knows the three live 15 Oct lead souls (Alfred: untouched) as souls the app shipped", async () => {
    expect(LIVE_15_OCT_LEAD_SOULS.map((l) => [l.monoId, new TextEncoder().encode(l.soul).length])).toEqual([
      ["hivra-lead", 2023],
      ["nibbii-lead", 2015],
      ["vg-game-lead", 2025],
    ]);
    for (const l of LIVE_15_OCT_LEAD_SOULS) expect(await isKnownSeededSoul(l.soul, l.values)).toBe(true);
    // One changed character and it isn't.
    expect(await isKnownSeededSoul(hivra.soul.replace("one row.", "one row!"), hivra.values)).toBe(false);
    // Today's templates are known too: the team's, a Lead's, the hub's own Lead's and the checker's.
    const monos = [
      { id: "chief-of-staff", name: "Chief of Staff", mascot: "letter", color: "x", projects: [] },
      { id: "nibbii-lead", name: "Nibbii lead", mascot: "letter", color: "x", projects: ["/Users/ash/Projects/nibbii"] },
      { id: "hub-lead", name: "MonoCode Hub lead", mascot: "letter", color: "x", projects: ["/Users/ash/Projects/monocode-hub"] },
      { id: "checker", name: "Checker", mascot: "robot", color: "x", projects: [] },
    ];
    for (const t of soulTemplates(monos)) expect([t.monoId, await isKnownSeededSoul(t.template, t.values)]).toEqual([t.monoId, true]);
  });

  it("swaps the untouched 15 Oct Hivra lead soul for today's, old soul saved, with Undo", async () => {
    const f = fakeFiles();
    f.set("hivra-lead", "SOUL.md", hivra.soul);
    expect(await refreshSouls(f, hivraTemplate, DAY)).toEqual({ refreshed: ["hivra-lead"], recorded: [], skipped: [] });
    const soul = f.get("hivra-lead", "SOUL.md")!;
    expect(soul.replace(/\s+$/, "")).toBe(template.replace(/\s+$/, ""));
    expect(soul).toContain("Your workers ask you, not Ash");
    expect(soul).not.toContain("ash_ask_ash");
    expect(f.get("hivra-lead", NOTE)).toBe(hivra.soul);
    expect(f.get("hivra-lead", SOUL_TEMPLATE_FILE)).toBe(template);
    const c = findBotChange(`soul-refresh:hivra-lead:${templateFingerprint(template)}`)!;
    expect(c.details!.some((d) => d.startsWith("Hivra lead will now confirm when work has really started"))).toBe(true);
    for (const text of [c.line, ...c.details!]) expectPlain(text);
    await undoBotChange([c.id]);
    expect(f.get("hivra-lead", "SOUL.md")).toBe(hivra.soul);
  });

  /** What soulTemplates gives a Lead whose roster carries `folder` (none, a wrong one, or the real one). */
  function leadEntry(l: (typeof LIVE_15_OCT_LEAD_SOULS)[number], folder: string | null, monoId = l.monoId) {
    const spec = { id: monoId, name: l.values.name, projectName: l.values.projectName, projectId: l.values.projectId } as Parameters<typeof leadSoul>[0];
    const render = (f: string | null) => defaultSoul(leadSoul(spec, f));
    return { monoId, name: l.values.name, template: render(folder), values: { ...l.values, id: monoId, folder }, render };
  }

  it("a roster with no folder: the untouched lead is still swapped, keeping the folder its soul names, and the row says so", async () => {
    for (const l of LIVE_15_OCT_LEAD_SOULS) {
      const id = `${l.monoId}-nofolder`;
      const f = fakeFiles();
      const soul = l.soul.replaceAll(`ASH_MONO_ID=${l.monoId}`, `ASH_MONO_ID=${id}`);
      f.set(id, "SOUL.md", soul);
      expect(await refreshSouls(f, [leadEntry(l, null, id)], DAY)).toEqual({ refreshed: [id], recorded: [], skipped: [] });
      const now = f.get(id, "SOUL.md")!;
      expect(now).toContain(`working in ${l.values.folder}.`);
      expect(now).toContain("Your workers ask you, not Ash");
      const row = botChangeRows().find((r) => r.kind === "one" && r.change.monoId === id);
      expect(row?.kind === "one" && row.change.details).toContain(
        `The app had no project folder for ${l.values.name}, so the folder its soul already named is kept.`,
      );
      if (row?.kind === "one") for (const t of row.change.details!) expectPlain(t);
    }
  });

  it("a roster with a different folder: still recognised as untouched; the new soul uses the roster's folder and says so", async () => {
    const exo = LIVE_15_OCT_LEAD_SOULS[2];
    const f = fakeFiles();
    const soul = exo.soul.replaceAll("ASH_MONO_ID=vg-game-lead", "ASH_MONO_ID=exo-wrong");
    f.set("exo-wrong", "SOUL.md", soul);
    const entry = leadEntry(exo, "/Users/ash/Projects/vg-game-moved", "exo-wrong");
    expect(await refreshSouls(f, [entry], DAY)).toEqual({ refreshed: ["exo-wrong"], recorded: [], skipped: [] });
    expect(f.get("exo-wrong", "SOUL.md")).toContain("working in /Users/ash/Projects/vg-game-moved.");
    const c = findBotChange(`soul-refresh:exo-wrong:${templateFingerprint(entry.template)}`)!;
    expect(c.details!.at(-1)).toBe("EXO lead's old soul named a different folder from the one its project is set to now; the new soul uses its project's folder.");
    for (const t of c.details!) expectPlain(t);
  });

  it("EXO's real folder, with a space and a '?', matches whether the roster names it or not", async () => {
    const exo = LIVE_15_OCT_LEAD_SOULS[2];
    expect(exo.values.folder).toBe("/Users/ash/Projects/boxin game?/vg-game");
    expect(folderInSoul(exo.soul)).toBe("/Users/ash/Projects/boxin game?/vg-game");
    for (const folder of [exo.values.folder, null, "/somewhere/else"])
      expect(await matchSeededSoul(exo.soul, { ...exo.values, folder })).not.toBeNull();
    const f = fakeFiles();
    f.set("vg-game-lead", "SOUL.md", exo.soul);
    expect((await refreshSouls(f, [leadEntry(exo, exo.values.folder)], DAY)).refreshed).toEqual(["vg-game-lead"]);
    expect(f.get("vg-game-lead", "SOUL.md")).toContain("working in /Users/ash/Projects/boxin game?/vg-game.");
    // An edit in the body is still an edit, whatever the folder.
    const edited = exo.soul.replace("- Parallel work is fine.", "- Ash: no Fridays.\n- Parallel work is fine.");
    expect(await matchSeededSoul(edited, { ...exo.values, folder: null })).toBeNull();
  });

  describe("the project's folder must be on this Mac", () => {
    // Real folders on disk, checked the way the app checks them (a folder, not a file), one with spaces in its path.
    const root = mkdtempSync(join(tmpdir(), "soul refresh folders "));
    const onDisk = async (path: string) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    };
    const exo = LIVE_15_OCT_LEAD_SOULS[2];
    const hivra15 = LIVE_15_OCT_LEAD_SOULS[0];
    function swap(l: (typeof LIVE_15_OCT_LEAD_SOULS)[number], id: string, folder: string) {
      const f = fakeFiles();
      f.set(id, "SOUL.md", l.soul.replaceAll(`ASH_MONO_ID=${l.monoId}`, `ASH_MONO_ID=${id}`));
      const entry = leadEntry(l, folder, id);
      return { f, entry, run: () => refreshSouls(f, [entry], DAY, onDisk) };
    }
    const details = (id: string) => {
      const row = botChangeRows().find((r) => r.kind === "one" && r.change.monoId === id);
      return row?.kind === "one" ? row.change.details! : [];
    };

    it("missing: the lead keeps its old soul's folder, and the row says so in plain words", async () => {
      const missing = join(root, "hivra-not-here");
      const { f, run } = swap(hivra15, "hivra-missing", missing);
      expect((await run()).refreshed).toEqual(["hivra-missing"]);
      const now = f.get("hivra-missing", "SOUL.md")!;
      expect(now).toContain(`working in ${hivra15.values.folder}.`);
      expect(now).not.toContain(missing);
      expect(now).toContain("Your workers ask you, not Ash");
      expect(details("hivra-missing")).toContain("Hivra lead kept its old folder because its project's folder wasn't found on this Mac.");
      expect(details("hivra-missing").some((d) => d.includes("different folder"))).toBe(false);
      for (const t of details("hivra-missing")) expectPlain(t);
    });

    it("there: the new soul uses the project's folder, as before", async () => {
      const there = join(root, "hivra");
      mkdirSync(there);
      const { f, run } = swap(hivra15, "hivra-there", there);
      expect((await run()).refreshed).toEqual(["hivra-there"]);
      expect(f.get("hivra-there", "SOUL.md")).toContain(`working in ${there}.`);
      expect(details("hivra-there")).toContain(
        "Hivra lead's old soul named a different folder from the one its project is set to now; the new soul uses its project's folder.",
      );
      expect(details("hivra-there").some((d) => d.includes("wasn't found"))).toBe(false);
    });

    it("a path with spaces (and EXO's '?'): found when it is there, the old folder kept when it isn't", async () => {
      // Windows can't name a folder with "?", so there it is only the spaces.
      const spaced = join(root, process.platform === "win32" ? "boxin game" : "boxin game?", "vg game moved");
      mkdirSync(spaced, { recursive: true });
      const found = swap(exo, "exo-spaced", spaced);
      expect((await found.run()).refreshed).toEqual(["exo-spaced"]);
      expect(found.f.get("exo-spaced", "SOUL.md")).toContain(`working in ${spaced}.`);

      const gone = swap(exo, "exo-spaced-gone", join(root, "boxin game?", "not here either"));
      expect((await gone.run()).refreshed).toEqual(["exo-spaced-gone"]);
      expect(gone.f.get("exo-spaced-gone", "SOUL.md")).toContain("working in /Users/ash/Projects/boxin game?/vg-game.");
      expect(details("exo-spaced-gone")).toContain("EXO lead kept its old folder because its project's folder wasn't found on this Mac.");
    });

    it("the same folder in the roster and the soul is never looked up", async () => {
      let asked = 0;
      const f = fakeFiles();
      f.set("vg-game-lead", "SOUL.md", exo.soul);
      await refreshSouls(f, [leadEntry(exo, exo.values.folder)], DAY, async () => {
        asked += 1;
        return false;
      });
      expect(asked).toBe(0);
      expect(f.get("vg-game-lead", "SOUL.md")).toContain("working in /Users/ash/Projects/boxin game?/vg-game.");
    });
  });

  it("leaves an edited soul alone, with one plain row and no Undo", async () => {
    const f = fakeFiles();
    const edited = hivra.soul.replace("- Parallel work is fine.", "- Ash: never touch the token page.\n- Parallel work is fine.");
    f.set("lead-x", "SOUL.md", edited);
    const t = [{ ...hivraTemplate[0], monoId: "lead-x", values: { ...hivra.values, id: "lead-x" } }];
    expect(await refreshSouls(f, t, DAY)).toEqual({ refreshed: [], recorded: [], skipped: ["lead-x"] });
    expect(f.get("lead-x", "SOUL.md")).toBe(edited);
    expect(f.get("lead-x", SOUL_TEMPLATE_FILE)).toBeUndefined();
    expect([...f.files.keys()].filter((k) => k.startsWith("lead-x/memory/"))).toEqual([]);
    const rows = botChangeRows().filter((r) => r.kind === "one" && r.change.monoId === "lead-x");
    expect(rows).toHaveLength(1);
    const c = rows[0].kind === "one" ? rows[0].change : undefined;
    expect(c?.line).toBe("Hivra lead's soul has your own changes, so the app's update was skipped. Ask Alfred to merge it if you want it.");
    expect(c?.note).toBe(true);
    expectPlain(c!.line);
    // Nothing to undo, and the next pass doesn't say it again.
    await undoBotChange([c!.id]);
    expect(f.get("lead-x", "SOUL.md")).toBe(edited);
    expect(findBotChange(c!.id)?.undone).toBeFalsy();
    expect(await refreshSouls(f, t, DAY)).toEqual({ refreshed: [], recorded: [], skipped: [] });
    expect(botChangeRows().filter((r) => r.kind === "one" && r.change.monoId === "lead-x")).toHaveLength(1);
  });
});

describe("plain sentences", () => {
  it("every section heading in the app's soul templates has its own sentence", () => {
    const lead = { id: "hub-lead", name: "MonoCode Hub lead", projectId: "hub", projectName: "MonoCode Hub" } as Parameters<typeof leadSoul>[0];
    const souls = [...Object.values(TEAM_SOULS).map((s) => defaultSoul(s)), defaultSoul(leadSoul(lead, "/x")), defaultSoul(CHECKER_SOUL)];
    const headings = new Set(souls.flatMap((s) => soulSections(s).map((x) => x.key.replace(/^## /, ""))));
    expect([...headings].filter((h) => !(h in SECTION_SENTENCES))).toEqual([]);
    for (const sentence of Object.values(SECTION_SENTENCES)) {
      expect(sentence).toContain("{name}");
      expectPlain(sentence);
      expect(sentence).toMatch(/\.$/);
    }
  });
});

describe("soulTemplates", () => {
  it("covers the team, each Lead (on its real folder) and the checker, and nobody else", () => {
    const monos = [
      { id: "chief-of-staff", name: "Chief of Staff", mascot: "letter", color: "x", projects: [] },
      { id: "hivra-lead", name: "Hivra lead", mascot: "letter", color: "x", projects: ["/Users/ash/Projects/Hivra"] },
      { id: "hub-lead", name: "MonoCode Hub lead", mascot: "letter", color: "x", projects: ["/Users/ash/Projects/monocode-hub"] },
      { id: "checker", name: "Checker", mascot: "robot", color: "x", projects: [] },
      { id: "some-mono", name: "Maya", mascot: "letter", color: "x", projects: [] },
    ];
    const t = soulTemplates(monos);
    expect(t.map((x) => x.monoId)).toEqual(["chief-of-staff", "hivra-lead", "hub-lead", "checker"]);
    expect(t[1].template).toContain("working in /Users/ash/Projects/Hivra");
    expect(t[1].template).toContain("Your workers ask you, not Ash");
    expect(t[2].template).toContain("You are hub-lead, the lead of hub.");
    expect(t[2].template).toContain("Developing the hub from inside the hub");
  });
});
