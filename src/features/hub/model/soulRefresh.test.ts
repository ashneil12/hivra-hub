// @vitest-environment happy-dom
// Soul refresh as a proposal (decided 20 Oct): a Mono whose soul is behind the app's template gets a proposed Bot change
// with Apply / Dismiss, then Undo; nothing is written until Apply, and edits Ash made by hand are kept. The Mono files
// are a stand-in for the Rust mono_read / mono_save commands (hash-checked, like mono.rs).
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyProposedChange,
  botChangeRows,
  dismissProposedChange,
  pendingProposals,
  setBotFiles,
  undoBotChange,
} from "./botChanges";
import { planSoulRefresh, refreshSouls, soulSections, soulTemplates, SOUL_TEMPLATE_FILE } from "./soulRefresh";
// (OLD_SOUL_NOTE is asserted by its path, as Ash would find it.)
import type { AgentFilePath } from "../../monos/model/monoFiles";

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
  for (const p of pendingProposals()) dismissProposedChange(p.id);
  localStorage.clear();
});

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
    expect(plan.kind).toBe("propose");
    if (plan.kind !== "propose") return;
    expect(plan.knownBaseline).toBe(true);
    expect(plan.kept).toEqual(["Your job"]);
    expect(plan.added).toEqual(["How you run the project", "Skills"]);
    expect(plan.after).toContain("- Ash: never touch the token page.");
    expect(plan.after).toContain("Start-ack");
  });

  it("respects a section Ash deleted and keeps one he added; drops one the template dropped that he never touched", () => {
    const seed = `${NEW_LEAD}\n## Old habit\n- do the old thing\n`;
    const mine = `${seed.replace(/## How you run the project[\s\S]*?(?=## Skills)/, "")}\n## Mine\n- my own rule\n`;
    const template = NEW_LEAD.replace("- Start-ack: your first reply cites the brief.", "- Start-ack: cite the brief and what started.");
    const plan = planSoulRefresh(mine, template, seed);
    if (plan.kind !== "propose") throw new Error(plan.kind);
    expect(plan.after).not.toContain("How you run the project");
    expect(plan.after).toContain("## Mine\n- my own rule");
    expect(plan.after).not.toContain("Old habit");
    expect(plan.dropped).toEqual(["Old habit"]);
  });

  it("keeps the skills a Mono picked up and adds new template skills", () => {
    const mine = NEW_LEAD.replace("- review-pr", "- review-pr\n- hivra-release");
    const template = NEW_LEAD.replace("- review-pr", "- review-pr\n- human-writing");
    const plan = planSoulRefresh(mine, template, NEW_LEAD);
    if (plan.kind !== "propose") throw new Error(plan.kind);
    expect(plan.after).toContain("- review-pr\n- hivra-release\n- human-writing");
  });

  it("proposes nothing when every changed section is one Ash rewrote", () => {
    const template = NEW_LEAD.replace("- You are mainly an orchestrator.", "- You orchestrate.");
    const mine = NEW_LEAD.replace("- You are mainly an orchestrator.", "- Ash's own words here.");
    expect(planSoulRefresh(mine, template, NEW_LEAD).kind).toBe("nothing-to-change");
  });
});

describe("refreshSouls: a soul behind its template becomes a proposed Bot change", () => {
  const templates = [{ monoId: "hivra-lead", name: "Hivra lead", template: NEW_LEAD }];

  it("proposes the 15 Oct lead soul's upgrade without writing it; Apply writes it, records the template, and Undo puts it back", async () => {
    const f = fakeFiles();
    f.set("hivra-lead", "SOUL.md", OLD_LEAD);
    const result = await refreshSouls(f, templates);
    expect(result.proposed).toEqual(["hivra-lead"]);
    // Nothing written yet.
    expect(f.get("hivra-lead", "SOUL.md")).toBe(OLD_LEAD);
    const [proposal] = pendingProposals();
    expect(proposal.line).toContain("check the text");
    expect(botChangeRows()[0]).toMatchObject({ kind: "one", change: { id: proposal.id, proposed: true } });

    expect(await applyProposedChange(proposal.id)).toBe(true);
    const applied = f.get("hivra-lead", "SOUL.md")!;
    expect(applied).toContain("Your workers ask you, not Ash.");
    expect(f.get("hivra-lead", SOUL_TEMPLATE_FILE)).toBe(NEW_LEAD);
    expect(pendingProposals()).toEqual([]);

    await undoBotChange([proposal.id]);
    expect(f.get("hivra-lead", "SOUL.md")).toBe(OLD_LEAD);
    // Undone is final for this template: the next pass doesn't propose it again (its sections now count as his).
    expect((await refreshSouls(f, templates)).proposed).toEqual([]);
  });

  it("records the template for a soul already on it, and proposes nothing", async () => {
    const f = fakeFiles();
    f.set("hivra-lead", "SOUL.md", NEW_LEAD);
    expect(await refreshSouls(f, templates)).toEqual({ proposed: [], recorded: ["hivra-lead"] });
    expect(f.get("hivra-lead", SOUL_TEMPLATE_FILE)).toBe(NEW_LEAD);
    expect(await refreshSouls(f, templates)).toEqual({ proposed: [], recorded: [] });
  });

  it("never proposes a dismissed upgrade again, until the template changes once more", async () => {
    const f = fakeFiles();
    f.set("hivra-lead", "SOUL.md", OLD_LEAD);
    await refreshSouls(f, templates);
    dismissProposedChange(pendingProposals()[0].id);
    expect(pendingProposals()).toEqual([]);
    expect((await refreshSouls(f, templates)).proposed).toEqual([]);
    const newer = [{ ...templates[0], template: `${NEW_LEAD}- one more rule\n` }];
    expect((await refreshSouls(f, newer)).proposed).toEqual(["hivra-lead"]);
    expect(f.get("hivra-lead", "SOUL.md")).toBe(OLD_LEAD);
  });

  it("refuses to apply over a soul that changed since it was proposed", async () => {
    const f = fakeFiles();
    f.set("hivra-lead", "SOUL.md", OLD_LEAD);
    await refreshSouls(f, templates);
    const [proposal] = pendingProposals();
    f.set("hivra-lead", "SOUL.md", `${OLD_LEAD}- Ash typed this a minute ago\n`);
    expect(await applyProposedChange(proposal.id)).toBe(false);
    expect(f.get("hivra-lead", "SOUL.md")).toContain("Ash typed this a minute ago");
    expect(pendingProposals()[0].problem).toContain("changed since this was proposed");
    // The next pass proposes over the new text instead.
    await refreshSouls(f, templates);
    expect(pendingProposals()).toHaveLength(1);
    const again = pendingProposals()[0];
    expect(again.beforeText).toContain("Ash typed this a minute ago");
    // With no recorded template his line can't be told from the old rules, so it isn't carried into the new soul…
    expect(again.after).toContain("The old soul is kept as the note memory/soul-before-refresh.md");
    // …but Apply keeps the whole old soul as a note, so nothing he typed is lost.
    expect(await applyProposedChange(again.id)).toBe(true);
    expect(f.get("hivra-lead", "memory/soul-before-refresh.md")).toContain("Ash typed this a minute ago");
  });

  it("skips a Mono that hasn't been seeded yet", async () => {
    const f = fakeFiles();
    expect(await refreshSouls(f, templates)).toEqual({ proposed: [], recorded: [] });
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
