import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { readSession } from "./sessionStore";
import { newSession } from "../model/session";
import { applyHarnessEvent } from "../../../integrations/harness/core/apply";
import { isCliNotice } from "../../../integrations/harness/core/cliNotices";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockReset());

// r63 (PM's C7 on 0.16.3): Claude Code's classifier billing notice was saved as a block in every Mono chat.
const NOTICE =
  "We're changing auto mode to no longer charge for classifier requests in Claude Code. However, this session isn't eligible because your requests go through 127.0.0.1:18317, which isn't compatible with this update. Nothing breaks: auto mode keeps working, and its classifier requests are billed as before. To fix it and access the new version of auto mode, ask your gateway to implement: https://code.claude.com/docs/en/auto-mode-classifier-billing";

it("knows the CLI's own notices and nothing else", () => {
  expect(isCliNotice(NOTICE)).toBe(true);
  expect(isCliNotice("Compacting conversation…")).toBe(false);
  expect(isCliNotice("I'll check the auto mode settings for you.")).toBe(false);
});

it("a CLI notice never becomes a block, so it is never saved", () => {
  const session = newSession("claude", "/tmp/a");
  expect(applyHarnessEvent(session, { type: "status", text: NOTICE }).blocks).toHaveLength(0);
  expect(applyHarnessEvent(session, { type: "status", text: "Compacting" }).blocks).toHaveLength(1);
});

it("one saved before the filter is left out when the chat loads", async () => {
  vi.mocked(invoke).mockResolvedValue({
    id: "s1",
    cwd: "/tmp/a",
    harness: "claude",
    model: "claude:grok-4.7",
    modelSettings: {},
    runtimeMode: "default",
    title: "frank",
    blocks: [
      { id: "u1", role: "user", text: "hi" },
      { id: "n1", role: "system", text: NOTICE },
      { id: "a1", role: "assistant", text: "Hello" },
    ],
  });
  expect((await readSession("s1"))?.blocks.map((b) => b.id)).toEqual(["u1", "a1"]);
});
