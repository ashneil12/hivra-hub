import { expect, it } from "vitest";
import { newSession } from "../../../features/sessions/model/session";
import { applyHarnessEvent } from "./apply";
import { noticeFromSystem, statusTextFromSystem } from "../providers/claude/claudeProtocol";

// r65 (PM's r63 run, block 502 role "system"): the billing notice arrives on Claude Code's stream as a
// `system/informational` record. claude.ts turns that into a `notice` event, a path r63 (status only) didn't filter.
const NOTICE =
  "We're changing auto mode to no longer charge for classifier requests in Claude Code. However, this session isn't eligible because your requests go through 127.0.0.1:18317, which isn't compatible with this update. Nothing breaks: auto mode keeps working, and its classifier requests are billed as before. To fix it and access the new version of auto mode, ask your gateway to implement: https://code.claude.com/docs/en/auto-mode-classifier-billing";

// Stream lines as the CLI prints them (one JSON object per line), parsed the way claude.ts parses stdout.
const lines = [
  `{"type":"system","subtype":"informational","level":"notice","content":${JSON.stringify(NOTICE)},"session_id":"8f1c","uuid":"u-1"}`,
  `{"type":"system","subtype":"informational","level":"warning","content":${JSON.stringify(NOTICE)},"session_id":"8f1c","uuid":"u-2"}`,
  `{"type":"system","subtype":"model_fallback","content":${JSON.stringify(NOTICE)},"session_id":"8f1c","uuid":"u-3"}`,
  `{"type":"system","subtype":"status","status":"working","message":${JSON.stringify(NOTICE)},"session_id":"8f1c","uuid":"u-4"}`,
].map((l) => JSON.parse(l) as Record<string, unknown>);

it("no real stream shape of the notice turns into an event", () => {
  for (const rec of lines) {
    expect(noticeFromSystem(rec)).toBeNull();
    expect(statusTextFromSystem(rec)).toBeUndefined();
  }
  // A real notice still comes through.
  expect(noticeFromSystem({ type: "system", subtype: "informational", level: "warning", content: "Hook blocked rm -rf" })?.text).toBe("Hook blocked rm -rf");
});

it("a notice, keyed notice or interjection with it is never a block, so never saved", () => {
  const s = newSession("claude", "/tmp/a");
  expect(applyHarnessEvent(s, { type: "notice", text: NOTICE, level: "notice" }).blocks).toHaveLength(0);
  expect(applyHarnessEvent(s, { type: "notice", text: NOTICE, level: "warning", key: "notice:t1" }).blocks).toHaveLength(0);
  expect(applyHarnessEvent(s, { type: "interjection", text: NOTICE, customType: "cli" } as never).blocks).toHaveLength(0);
  expect(applyHarnessEvent(s, { type: "notice", text: "Model fell back to Sonnet", level: "warning" }).blocks).toHaveLength(1);
});
