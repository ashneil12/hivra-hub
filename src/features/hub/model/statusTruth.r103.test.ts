// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { openPartsOf, runningWorkers, statusTruthLine } from "./statusTruth";
import { COS_CALL_NOTE, FIRST_REPLY_NOTE, STATUS_SHAPE, isDump, withInboxCount } from "./inboxCountNote";
import { withCountLineChecked } from "../../../shared/text/countLine";
import { cutWorkNote } from "../../sessions/model/inFlight";
import { parseNeedsAsh } from "./chatQuestions";

// The worker report B5 0255 got at +1634s (shortened).
const REPORT = [
  "## Not in this change",
  "- **Settings scroll.** The page that scrolls is `src/features/settings/`. This lane cannot change that. It needs a real build from the MonoCode Hub lead.",
  "- **Pin a chat.** Already there. Right-click a chat and choose Pin.",
  '- **Red "needs you" count.** The grey unread number now clears when you answer that chat. The red number is lead-only.',
  "- **Dock badge.** The screen no longer lets an older count land after a newer one. The macOS side (`set_dock_badge` in the engine) was not touched.",
  "## Commits",
  "- `0929c29a` Rail badge clears after an answer",
  "## Self-review",
  "Unsure: whether the rail badge you meant is the grey unread count (cleared here) or the red needs-you count (lead-only).",
].join("\n");
const completion = { role: "user", text: REPORT, monoSessionCompletion: { sessionId: "w1", title: "Hub fixes", status: "completed" } } as const;
const spawn = { role: "user", text: "dump", monoSpawnedSessions: [{ sessionId: "w1", cwd: "/p", title: "Hub fixes", harness: "claude", model: "x" }] } as const;

describe("r103 (4): a part a worker said it didn't do is never counted done", () => {
  it("lifts the not-done parts and the unsure line from the worker's report, not the done or already-there ones", () => {
    const parts = openPartsOf([spawn, completion] as never);
    expect(parts.some((p) => /macOS side .* was not touched/.test(p))).toBe(true);
    expect(parts.some((p) => /lead-only/.test(p))).toBe(true);
    expect(parts.some((p) => /^unsure: whether the rail badge/.test(p))).toBe(true);
    expect(parts.some((p) => /Settings scroll/.test(p))).toBe(true);
    expect(parts.some((p) => /Pin a chat|0929c29a/.test(p))).toBe(false);
  });
  it("the status question carries them, with the rule", () => {
    const wire = withInboxCount("lead1", "wat happened to the stuff i dumped earlier", () => true, [], { blocks: [spawn, completion] as never, sessions: [] });
    expect(wire).toMatch(/NOT done: .*macOS side/);
    expect(wire).toMatch(/never count it under done/);
  });
});

describe("r103 (3): running means running now, from the app", () => {
  it("a worker that reported back is not running", () => {
    expect(runningWorkers([spawn] as never, [{ id: "w1", busy: false, title: "Hub fixes" }])).toEqual([]);
    expect(runningWorkers([spawn] as never, [{ id: "w1", busy: true, title: "Hub fixes" }])).toEqual(["Hub fixes"]);
    expect(statusTruthLine([], [])).toMatch(/Never call anything "in progress"/);
    expect(statusTruthLine(["Hub fixes"], [])).toMatch(/Running right now, from the app: Hub fixes/);
  });
  it("the turn a restart resumes says what runs now", () => {
    const wire = withInboxCount("lead1", "Continue from where you left off.", () => true, [], { blocks: [spawn] as never, sessions: [{ id: "w1", busy: false, title: "Hub fixes" }] });
    expect(wire).toMatch(/Nothing of yours is running right now/);
  });
});

it("r103 (2): a dump gets a first reply in two short lines before any tool call; a single ask doesn't", () => {
  const dump = "ok brain dump before i forget, hub stuff first. inbox rows r still too tall on the laptop. the settings page scrolls weird. want a shortcut for a new chat. terminal font is tiny.";
  expect(isDump(dump)).toBe(true);
  expect(withInboxCount("lead1", dump, () => true)).toContain(FIRST_REPLY_NOTE);
  expect(FIRST_REPLY_NOTE).toMatch(/before any tool call/);
  expect(isDump("can you fix the send button")).toBe(false);
  expect(withInboxCount("w1", dump, () => false)).toBe(dump);
});

it("r103 (5): already there folds into done and still shows", () => {
  expect(withCountLineChecked("Of 40: 14 done, 2 already there, 1 waiting on you, 23 parked.").split("\n")[0]).toBe("Of 40: 16 done (2 already there), 1 waiting on you, 23 parked.");
});

it("r103 (Critiquito c): a reply counting asks as waiting never also says his Inbox is empty", () => {
  const out = withCountLineChecked("Of 40: 13 done, 5 waiting on you, 22 parked.\n\nNothing from me is in your Inbox. Done: the fixes.");
  expect(out).not.toMatch(/Nothing from me/);
  expect(out).toContain("Done: the fixes.");
  expect(withCountLineChecked("Of 3: 3 done.\n\nNothing from me is in your Inbox.")).toMatch(/Nothing from me is in your Inbox/);
});

it("r103 (Critiquito b, c, d; 7): the status shape keeps holds on the Inbox, parked lines whole, and Chief of Staff's call", () => {
  expect(STATUS_SHAPE).toMatch(/count only what is on his Inbox/);
  expect(STATUS_SHAPE).toMatch(/needs his yes or his pick is never parked/);
  expect(STATUS_SHAPE).toMatch(/Parked: the settings scroll, because that page needs a real build from the Hub lead\./);
  expect(STATUS_SHAPE).toMatch(/never a numbered list/);
  expect(STATUS_SHAPE).toMatch(/Chief of Staff already made a call/);
  const msg = "[MonoCode message from Chief of Staff]\n<message>Stripe: check and report only.</message>";
  expect(withInboxCount("lead1", msg, () => true)).toContain(COS_CALL_NOTE);
  expect(COS_CALL_NOTE).toMatch(/only Ash can override it/);
});

it("r103 (6): Ash's question cut by a restart never shows as a task with an ask id", () => {
  const note = cutWorkNote([{ kind: "task", id: "ask-1", label: "Which shortcut should open a new chat? [⌘N / ⌘⇧N]" }]);
  expect(note).toBeNull();
  const other = cutWorkNote([{ kind: "task", id: "ask-1", label: "Which shortcut?" }, { kind: "shell", id: "b7", label: "npm test" }]);
  expect(other).not.toMatch(/ask-1/);
  expect(other).toMatch(/npm test/);
});

it("r103 (8): Chief of Staff's \"Needs you:\" line is an ask like \"Needs Ash:\"", () => {
  expect(parseNeedsAsh("Both bounced.\n\n**Needs you:** reconnect Hivra and Nibbii on this machine.\nMy pick: reconnect both.")?.question).toMatch(/reconnect Hivra and Nibbii/);
});
