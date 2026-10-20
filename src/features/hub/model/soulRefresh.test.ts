// @vitest-environment happy-dom
// Soul refresh, applied on its own (decided 20 Oct; Ash's 14 Oct rule: bigger bot changes apply themselves, land in Bot
// changes with Undo and never wait for a click). Ash's hand edits win, the row says in plain words what changes for the
// Mono and what was skipped, and the whole old soul is saved first. The Mono files are a stand-in for the Rust
// mono_read / mono_save commands (hash-checked, like mono.rs).
import { beforeEach, describe, expect, it } from "vitest";
import { botChangeRows, findBotChange, redoBotChange, setBotFiles, undoBotChange } from "./botChanges";
import {
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

  it("refreshes the 15 Oct lead soul without a click, saves the old soul first, and Undo / Redo work", async () => {
    const f = fakeFiles();
    f.set("hivra-lead", "SOUL.md", OLD_LEAD);
    expect(await refreshSouls(f, templates, DAY)).toEqual({ refreshed: ["hivra-lead"], recorded: [] });
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
    // One plain sentence per section that changed, then the note about the old soul.
    expect(c.details).toEqual([
      "Hivra lead will now act as an orchestrator: small things itself, bigger pieces to workers with Ash's own words, and it talks to Chief of Staff rather than Ash unless the work is routed to him.",
      "Hivra lead will now confirm when work has really started, keep anything stuck visible with the reason, and ask Ash only from its own chat when it can't go on without him.",
      "Hivra lead picks up the app's newer skills and keeps the ones it learned.",
      "The app couldn't tell your own edits from its old wording here, so the whole old soul is saved in Hivra lead's memory and Undo puts it back.",
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
    expect(await refreshSouls(f, [{ ...templates[0], monoId: "lead-c" }], DAY)).toEqual({ refreshed: [], recorded: ["lead-c"] });
    expect(f.get("lead-c", SOUL_TEMPLATE_FILE)).toBe(NEW_LEAD);
    expect(await refreshSouls(f, [{ ...templates[0], monoId: "lead-c" }], DAY)).toEqual({ refreshed: [], recorded: [] });
    expect(botChangeRows().some((r) => r.kind === "one" && r.change.monoId === "lead-c")).toBe(false);
  });

  it("a later template refreshes again, keeping each old soul in its own note", async () => {
    const f = fakeFiles();
    f.set("lead-d", "SOUL.md", OLD_LEAD);
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
    expect(await refreshSouls(f, templates, DAY)).toEqual({ refreshed: [], recorded: [] });
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
    expect(t[2].template).toContain("ASH_MONO_ID=hub-lead");
    expect(t[2].template).toContain("Developing the hub from inside the hub");
  });
});
