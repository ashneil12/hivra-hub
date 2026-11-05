// Agent prompts name this copy's memory folder as an absolute path (portable.rs Env::memory_root).
// A tilde is not a path: a model expands "~" to the real user even when HOME is a temp bench folder.
import { afterEach, describe, expect, it } from "vitest";
import { workerRules } from "../../agent-app/model/agentAppTasks";
import { ashAnsweredLeadNote } from "../../monos/model/ashAnswersWorker";
import { newSession, type Block, type Session } from "../../sessions/model/session";
import { saveRuleWhere, standingRuleNudge, standingRuleSendNote } from "../../monos/model/workerStartNudge";
import { leadBriefPrompt } from "./leadershipDelegation";
import { memoryPrimerBlock, type MemoryPrimer } from "./hubMemoryPrimer";
import { monoHomeFence, setMonoHomeRoot } from "./hubMcp";
import { promptSurfaces } from "./promptSurfaces.testkit";
import {
  agentMemoryRoot,
  memoryTools,
  projectMemoryDirs,
  resetAgentMemoryForTests,
  resolveAgentMemoryRoot,
  setAgentMemoryRoot,
  setMemoryTools,
  type MemoryLayout,
} from "./agentMemoryPath";

const DAILY: MemoryLayout = { kind: "daily", home: "/Users/ada" };
const DEV: MemoryLayout = {
  kind: "dev",
  home: "/Users/ada",
  dataDir: "/Users/ada/Library/Application Support/com.ash.monocode-hub.dev.slot",
};
const TEMP: MemoryLayout = {
  kind: "dev",
  home: "/tmp/hivra-bench-home",
  dataDir: "/tmp/hivra-bench-home/Library/Application Support/com.ash.monocode-hub.dev.bench",
};

const LOADED: MemoryPrimer = {
  project: "hivra",
  name: "Hivra",
  text: "- Keep the rows",
  memory_dir: "~/agent-memory/hivra",
  global_dir: "~/agent-memory/ash",
};

const ash = (text: string): Block => ({ id: "u1", role: "user", text, startedAt: 1_000 });
const said = (text: string): Block => ({ id: "a1", role: "assistant", text });
const chat = (blocks: Block[]): Session => ({ ...newSession("claude", "/p"), id: "team", blocks });

/** Every agent-facing prompt this package builds. UI copy (DecisionsPage) is not here. */
function agentPrompts(): string[] {
  const readers = [false, true].flatMap((worker) => [
    memoryPrimerBlock("hivra", undefined, { worker }),
    memoryPrimerBlock("hivra", LOADED, { worker }),
  ]);
  const rule = "from now on always run npm test before you call something done";
  const nudge = standingRuleNudge(chat([ash(`fix the board. ${rule}`), said("Five jobs.")]), new Set());
  return [
    ...readers,
    saveRuleWhere(),
    standingRuleSendNote(rule) ?? "",
    nudge?.text ?? "",
    ashAnsweredLeadNote({ id: "t1", title: "Keep rows" }, "keep them 30 days", "k1").text,
    workerRules(41000),
    leadBriefPrompt("Ada", "Fix the save."),
    monoHomeFence(),
    ...Object.values(promptSurfaces()),
  ];
}

function useLayout(layout: MemoryLayout, monoHome: string): string {
  const root = resolveAgentMemoryRoot(layout);
  expect(root).toBeTruthy();
  setAgentMemoryRoot(root);
  setMonoHomeRoot(monoHome);
  return root!;
}

afterEach(() => {
  resetAgentMemoryForTests();
  setMonoHomeRoot(undefined);
});

describe("the memory root this copy uses", () => {
  it("the daily app keeps memory in its own HOME", () => {
    expect(resolveAgentMemoryRoot(DAILY)).toBe("/Users/ada/agent-memory");
    expect(resolveAgentMemoryRoot({ kind: "daily", home: "C:/Users/ada/" })).toBe("C:/Users/ada/agent-memory");
  });

  it("a dev slot keeps memory in its data folder, not the daily ~/agent-memory", () => {
    const root = resolveAgentMemoryRoot(DEV);
    expect(root).toBe(`${DEV.dataDir}/agent-memory`);
    expect(root).not.toBe("/Users/ada/agent-memory");
  });

  it("a temp-HOME dev copy points at the temp folder, never the real user's /Users/<name>", () => {
    const root = resolveAgentMemoryRoot(TEMP);
    expect(root).toBe(`${TEMP.dataDir}/agent-memory`);
    expect(root!.startsWith("/tmp/hivra-bench-home/")).toBe(true);
    expect(root).not.toMatch(/\/Users\/[^/]+/);
    // A named override still has to be absolute. A tilde, a relative path or ".." is ignored.
    expect(resolveAgentMemoryRoot({ ...TEMP, override: "/tmp/hivra-bench-home/run-memory" })).toBe(
      "/tmp/hivra-bench-home/run-memory",
    );
    expect(resolveAgentMemoryRoot({ ...TEMP, override: "~/agent-memory" })).toBe(`${TEMP.dataDir}/agent-memory`);
    expect(resolveAgentMemoryRoot({ ...TEMP, override: "relative/memory" })).toBe(`${TEMP.dataDir}/agent-memory`);
    expect(resolveAgentMemoryRoot({ ...TEMP, override: "/tmp/hivra-bench-home/../Users/ada/agent-memory" })).toBe(
      `${TEMP.dataDir}/agent-memory`,
    );
    // No data folder and no override: do not guess the daily folder.
    expect(resolveAgentMemoryRoot({ kind: "dev", home: "/tmp/hivra-bench-home" })).toBeUndefined();
    expect(resolveAgentMemoryRoot({ kind: "daily" })).toBeUndefined();
  });

  it("rejects a root a caller hands in that is not an absolute path", () => {
    setAgentMemoryRoot("~/agent-memory");
    setAgentMemoryRoot("/tmp/hivra-bench-home/../Users/ada/agent-memory");
    setAgentMemoryRoot("relative/agent-memory");
    expect(agentMemoryRoot()).toBeUndefined();
    setAgentMemoryRoot("/tmp/hivra-bench-home/agent-memory/");
    expect(agentMemoryRoot()).toBe("/tmp/hivra-bench-home/agent-memory");
  });

  it("does not let a primer path escape this copy's root or climb with ..", () => {
    setAgentMemoryRoot("/tmp/hivra-bench-home/agent-memory");
    expect(projectMemoryDirs("hivra", { memory_dir: "/Users/ada/agent-memory/hivra", global_dir: "~/agent-memory/ash" })).toEqual({
      project: "/tmp/hivra-bench-home/agent-memory/hivra",
      ash: "/tmp/hivra-bench-home/agent-memory/ash",
    });
    expect(projectMemoryDirs("../ada").project).toBeUndefined();
    expect(projectMemoryDirs("hivra/../../etc").project).toBeUndefined();
    expect(projectMemoryDirs("").project).toBeUndefined();
    // A directory that only shares a prefix is not inside the root.
    expect(
      projectMemoryDirs("hivra", { memory_dir: "/tmp/hivra-bench-home/agent-memory-evil/hivra" }).project,
    ).toBe("/tmp/hivra-bench-home/agent-memory/hivra");
  });
});

describe("agent prompts", () => {
  it("no agent-facing prompt string still contains ~/agent-memory", () => {
    useLayout(DAILY, "/Users/ada/agent-memory/monos");
    for (const text of agentPrompts()) expect(text, text.slice(0, 80)).not.toContain("~/agent-memory");
  });

  it("names the daily folder, a dev slot's folder, and a temp-HOME folder", () => {
    const cases: [MemoryLayout, string][] = [
      [DAILY, "/Users/ada/agent-memory/monos"],
      [DEV, `${DEV.dataDir}/monos`],
      [TEMP, `${TEMP.dataDir}/monos`],
    ];
    for (const [layout, monoHome] of cases) {
      const root = useLayout(layout, monoHome);
      const block = memoryPrimerBlock("hivra", undefined, { worker: false });
      expect(block).toContain(`${root}/hivra/MEMORY.md`);
      expect(block).toContain(`${root}/ash/MEMORY.md`);
      expect(saveRuleWhere()).toContain(`${root}/<project>/decisions.md`);
      expect(saveRuleWhere()).toContain(`${root}/ash/decisions.md`);
      expect(monoHomeFence()).toContain(`${monoHome}/`);
      expect(workerRules(41000)).toContain(`${monoHome}/`);
      if (layout === TEMP) {
        for (const text of agentPrompts()) {
          expect(text).not.toMatch(/\/Users\/[^/]+/);
          expect(text).not.toContain("~/agent-memory");
        }
      }
      if (layout === DEV) {
        const lead = memoryPrimerBlock("hivra", undefined, { worker: false });
        expect(lead).not.toContain("/Users/ada/agent-memory/");
        expect(lead).toContain("Application Support");
      }
    }
  });

  it("a primer that names another home is not repeated: the prompt keeps this copy's root", () => {
    const root = useLayout(TEMP, `${TEMP.dataDir}/monos`);
    const block = memoryPrimerBlock("hivra", { ...LOADED, memory_dir: "/Users/ada/agent-memory/hivra", global_dir: "/Users/ada/agent-memory/ash" }, { worker: false });
    expect(block).toContain(`${root}/hivra`);
    expect(block).not.toContain("/Users/ada");
    expect(block).not.toContain("~");
  });

  it("an unsafe project id is not joined onto the root", () => {
    useLayout(TEMP, `${TEMP.dataDir}/monos`);
    const block = memoryPrimerBlock("../ada", undefined, { worker: false });
    expect(block).not.toContain("..");
    expect(block).toContain("this project");
    expect(block).not.toContain("/ada");
  });

  it("names the memory tool first and the path second, and only when the chat has it", () => {
    const root = useLayout(TEMP, `${TEMP.dataDir}/monos`);
    expect(memoryTools()).toBe(false);
    for (const text of agentPrompts()) expect(text).not.toMatch(/ash_(recall|remember)/);

    setMemoryTools(true);
    const missing = memoryPrimerBlock("hivra", undefined, { worker: false });
    expect(missing.indexOf("ash_recall")).toBeGreaterThanOrEqual(0);
    expect(missing.indexOf("ash_recall")).toBeLessThan(missing.indexOf(`${root}/hivra/MEMORY.md`));

    const lead = memoryPrimerBlock("hivra", { project: "hivra", text: "- one" }, { worker: false });
    expect(lead.indexOf("ash_remember")).toBeGreaterThanOrEqual(0);
    expect(lead.indexOf("ash_remember")).toBeLessThan(lead.indexOf(`${root}/hivra/decisions.md`));
    // A worker reports; it does not save.
    expect(memoryPrimerBlock("hivra", { project: "hivra", text: "- one" }, { worker: true })).not.toContain("ash_remember");

    const where = saveRuleWhere();
    expect(where.indexOf("ash_remember")).toBeGreaterThanOrEqual(0);
    expect(where.indexOf("ash_remember")).toBeLessThan(where.indexOf(`${root}/<project>/decisions.md`));
    const answer = ashAnsweredLeadNote({ id: "t1", title: "Keep rows" }, "keep them", "k1").text;
    expect(answer.indexOf("ash_remember")).toBeLessThan(answer.indexOf(`${root}/<project>/decisions.md`));
  });
});
