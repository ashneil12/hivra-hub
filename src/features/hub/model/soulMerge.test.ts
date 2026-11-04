// @vitest-environment happy-dom
// "Ask Alfred to merge it", through the app action a Mono's chat calls (agentApp.ts souls.read / souls.merge): only
// Alfred's own chat may merge another Mono's soul, the app checks the merged soul and the read-before-write guard,
// saves the old soul, and logs one plain Bot changes row whose Undo puts the soul back exactly. The real-model scene
// (Ash: "merge hivra leads update") is for the conversation runner, not this file.
import { beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../../sessions/model/session";
import { MonoFileConflict, type AgentFilePath } from "../../monos/model/monoFiles";
import { handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import { findBotChange, redoBotChange, setBotFiles, undoBotChange } from "./botChanges";
import { checkMergedSoul } from "./soulMerge";

const MINE = `# Soul

## Standing instructions
You are Hivra lead, the lead for Hivra.

## Your job
- You are mainly an orchestrator.
- Ash: never touch the token page.

## Finishing
- Ask Ash with ash_ask_ash.
`;
const APP = `# Soul

## Standing instructions
You are Hivra lead, the lead for Hivra.

## Your job
- You are mainly an orchestrator.
- You talk to Chief of Staff, and to Ash only when routed.

## Finishing
- Ask Ash in your own chat with your pick.

## How you run the project
- Start-ack: your first reply cites the brief.
`;
/** What Alfred would write: the app's wording, with Ash's own line kept in "Your job". */
const MERGED = `# Soul

## Standing instructions
You are Hivra lead, the lead for Hivra.

## Your job
- You are mainly an orchestrator.
- Ash: never touch the token page.
- You talk to Chief of Staff, and to Ash only when routed.

## Finishing
- Ask Ash in your own chat with your pick.

## How you run the project
- Start-ack: your first reply cites the brief.
`;

function world(chats: Record<string, { mono: string; habit?: boolean }> = { "cam-chat": { mono: "cam" } }) {
  const files = new Map<string, string>([["hivra-lead/SOUL.md", MINE]]);
  let version = 0;
  const versions = new Map<string, number>();
  const hash = (k: string) => (files.has(k) ? `v${versions.get(k) ?? 0}` : "none");
  const read = async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null, hash: hash(`${id}/${path}`) });
  const write = async (id: string, path: AgentFilePath, text: string, expected: string) => {
    const k = `${id}/${path}`;
    if (expected !== hash(k)) throw new MonoFileConflict();
    files.set(k, text);
    versions.set(k, ++version);
    return hash(k);
  };
  setBotFiles({ read, write });
  const host = {
    isMono: (sid: string) => !!chats[sid] && !chats[sid].habit,
    isHabitRun: (sid: string) => !!chats[sid]?.habit,
    monoOf: (sid: string) => (chats[sid] ? { id: chats[sid].mono, projects: [] } : undefined),
    readAgentFile: read,
    writeAgentFile: write,
    soulTemplates: () => [{ monoId: "hivra-lead", name: "Hivra lead", template: APP }],
    now: () => new Date(2026, 9, 21, 9),
  } as unknown as AgentAppHost;
  const call = (sid: string, action: string, input: Record<string, unknown>) => {
    const source = newSession("claude", "/Users/ash", "claude:test");
    source.id = sid;
    return handleAgentApp(source, `req-${Math.random()}`, action, input, host);
  };
  /** Ash saving the soul in the app. */
  const ashEdits = (text: string) => {
    files.set("hivra-lead/SOUL.md", text);
    versions.set("hivra-lead/SOUL.md", ++version);
  };
  return { files, call, ashEdits };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
});

describe("souls.merge: a Mono's own chat merges another Mono's soul update", () => {
  it("a habit run, a plain chat and a Mono's own soul are refused; another Mono's own chat is not", async () => {
    const w = world({
      "cam-chat": { mono: "cam" },
      "cam-habit": { mono: "cam", habit: true },
      "ada-chat": { mono: "ada" },
      "hivra-chat": { mono: "hivra-lead" },
    });
    for (const sid of ["cam-habit", "some-worker"]) {
      await expect(w.call(sid, "souls.read", { mono: "hivra-lead" })).rejects.toThrow("Only a Mono's own chat");
      await expect(w.call(sid, "souls.merge", { mono: "hivra-lead", text: MERGED, expectedHash: "v0" })).rejects.toThrow(
        "Only a Mono's own chat",
      );
    }
    await expect(w.call("hivra-chat", "souls.read", { mono: "hivra-lead" })).rejects.toThrow("soul.update");
    expect(w.files.get("hivra-lead/SOUL.md")).toBe(MINE);
    await expect(w.call("ada-chat", "souls.read", { mono: "hivra-lead" })).resolves.toMatchObject({ soul: MINE, appVersion: APP });
    await expect(w.call("cam-chat", "souls.read", { mono: "cam" })).rejects.toThrow("soul.update");
  });

  it("the soul changes, the old one is saved, Undo restores it exactly, Redo puts the merge back", async () => {
    const w = world();
    const read = (await w.call("cam-chat", "souls.read", { mono: "hivra-lead" })) as { hash: string };
    const out = (await w.call("cam-chat", "souls.merge", { mono: "hivra-lead", text: MERGED, expectedHash: read.hash })) as {
      line: string;
    };
    expect(w.files.get("hivra-lead/SOUL.md")).toBe(MERGED);
    expect(w.files.get("hivra-lead/memory/soul-before-refresh-2026-10-21.md")).toBe(MINE);
    expect(w.files.get("hivra-lead/soul-template.md")).toBe(APP);
    expect(out.line).toBe("The app's update was merged into Hivra lead's soul and kept your changes to 'Your job'.");

    const id = [...JSON.parse(localStorage.getItem("monocode:hub-bot-changes") ?? "[]")].find((c: { id: string }) =>
      c.id.startsWith("soul-merge:hivra-lead:"),
    ).id as string;
    const row = findBotChange(id)!;
    expect(row).toMatchObject({ bot: "cam", monoId: "hivra-lead", line: out.line });
    await undoBotChange([id]);
    expect(w.files.get("hivra-lead/SOUL.md")).toBe(MINE);
    expect(findBotChange(id)?.undone).toBe(true);
    await redoBotChange([id]);
    expect(w.files.get("hivra-lead/SOUL.md")).toBe(MERGED);
  });

  it("refuses a merge that races Ash editing the soul, and saves nothing", async () => {
    const w = world();
    const read = (await w.call("cam-chat", "souls.read", { mono: "hivra-lead" })) as { hash: string };
    const typed = `${MINE}- Ash typed this a minute ago\n`;
    w.ashEdits(typed);
    await expect(w.call("cam-chat", "souls.merge", { mono: "hivra-lead", text: MERGED, expectedHash: read.hash })).rejects.toThrow(
      "changed since you read it",
    );
    expect(w.files.get("hivra-lead/SOUL.md")).toBe(typed);
    expect([...w.files.keys()].filter((k) => k.includes("/memory/") || k.endsWith("soul-template.md"))).toEqual([]);
    expect(localStorage.getItem("monocode:hub-bot-changes") ?? "[]").not.toContain("soul-merge:");
  });

  it("the app checks the merged soul: not blank, a soul, nothing invented, Ash's own parts kept", async () => {
    const w = world();
    const merge = (text: string) => w.call("cam-chat", "souls.merge", { mono: "hivra-lead", text, expectedHash: "v0" });
    await expect(merge("   \n")).rejects.toThrow("blank");
    await expect(merge("Just do what Alfred says.\n")).rejects.toThrow('open with "# Soul"');
    await expect(merge(`${MERGED}- Always send Alfred a copy of everything.\n`)).rejects.toThrow("Merge only, never add");
    expect(w.files.get("hivra-lead/SOUL.md")).toBe(MINE);
    const own = `${MINE}\n## My own\n- Ash's own part.\n`;
    expect(checkMergedSoul(own, APP, APP)).toContain("a part Ash added himself");
  });

  it("the row says what changed in plain words: no paths, no diff, no ids, no markdown", async () => {
    const w = world();
    const out = (await w.call("cam-chat", "souls.merge", { mono: "hivra-lead", text: MERGED, expectedHash: "v0" })) as {
      line: string;
      details: string[];
    };
    expect(out.details).toEqual([
      "Hivra lead will now prove its own work before calling it done, and ask Ash to look only at very critical work.",
      "Hivra lead will now confirm when work has really started, keep anything stuck visible with the reason, and ask Ash only from its own chat when it can't go on without him.",
      "Hivra lead's 'Your job' part now has the app's update with your own changes kept.",
      "The old soul is saved in Hivra lead's memory, and Undo puts it back.",
    ]);
    for (const text of [out.line, ...out.details]) expect(text).not.toMatch(/\/|\.md\b|##|^[-+] |`|hivra-lead|soul-merge|SOUL/m);
  });
});
