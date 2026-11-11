// @vitest-environment happy-dom
// WP-182: a skill the Mono names still gets a line when it is not in the pstack index.
import { beforeEach, expect, it, vi } from "vitest";
import { setClaudePluginLaunch, claudePluginLaunch } from "../../../integrations/harness/providers/claude/claudeExtraArgs";
import { savePlainEnglishEndings } from "../../firstmate/model/plainEnglish";
import { addMono, saveMonoSessionId } from "../../monos/model/mono";
import { sessionInstruction } from "./pstackAutopilot";
import { NO_WIRING, type PluginWiring } from "./pluginWiring";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: async (cmd: string) => {
    if (cmd === "list_skills") {
      return [
        {
          name: "local-skill",
          description: "Checks the invoice twice.",
          path: "/work/hivra/.claude/skills/local-skill/SKILL.md",
          scope: "project",
          source: "claude",
        },
      ];
    }
    throw new Error(`unexpected ${cmd}`);
  },
}));

const { registerPluginSessions } = await import("./pluginSessions");

const wiring: PluginWiring = {
  ...NO_WIRING,
  claudePluginDirs: ["/plugins/claude/pstack"],
};

beforeEach(() => {
  localStorage.clear();
  savePlainEnglishEndings(true);
  registerPluginSessions(async () => wiring);
});

it("writes a line from the discovered skill instead of dropping the skill list", async () => {
  addMono({
    id: "ada",
    name: "Ada",
    mascot: "robot",
    color: "x",
    projects: [],
    engine: "claude",
    skills: ["local-skill", "architect"],
  });
  saveMonoSessionId("ada", "sess-ada");
  const launch = await claudePluginLaunch("/work/hivra", "sess-ada");
  const text = launch.append ?? "";
  const onlyPlain = sessionInstruction({ plainEnglish: true });
  expect(text).not.toBe(onlyPlain);
  expect(text).toContain("local-skill | ");
  expect(text).toContain("Checks the invoice twice.");
  expect(text).toContain("architect | ");
  expect(text).not.toContain("\narena | ");

  addMono({
    id: "bo",
    name: "Bo",
    mascot: "robot",
    color: "x",
    projects: [],
    engine: "claude",
    skills: ["local-skill"],
  });
  saveMonoSessionId("bo", "sess-bo");
  const only = await claudePluginLaunch("/work/hivra", "sess-bo");
  const onlyText = only.append ?? "";
  expect(onlyText).not.toBe(onlyPlain);
  expect(onlyText).toContain("local-skill | ");
  expect(onlyText).toContain("Checks the invoice twice.");
  setClaudePluginLaunch(undefined);
});
