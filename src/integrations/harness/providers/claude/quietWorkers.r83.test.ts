import { describe, expect, it } from "vitest";
import { buildClaudeSpawnArgs } from "./claudeProtocol";
import { withWorkerNotificationsOff } from "./quietWorkers";

describe("hub workers raise no notifications of their own (r83)", () => {
  it("turns Claude Code's pushes and permission notify hooks off and keeps what was asked", () => {
    const s = withWorkerNotificationsOff({ fastMode: true, env: { CLAUDE_CODE_SUBAGENT_MODEL: "grok" } });
    expect(s).toMatchObject({ fastMode: true, agentPushNotifEnabled: false, inputNeededNotifEnabled: false, taskCompleteNotifEnabled: false });
    expect(s.env).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "grok", CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS: "1" });
  });

  it("rides on the spawn's --settings flag, and every hub spawn uses it", () => {
    const args = buildClaudeSpawnArgs({ settings: withWorkerNotificationsOff({}) } as never);
    const flag = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(flag.agentPushNotifEnabled).toBe(false);
    expect(flag.env.CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS).toBe("1");
  });
});
