// @vitest-environment happy-dom
// Today once questions live in the chats that own the work, read a project at a time (G1): "Waiting on you" (one row per
// waiting chat, Take the pick, Open, a reply in Ash's words, several cleared in a row), "Needs you" with only the gates
// and failures, and the old queue as one quiet "Older questions (N)" Ash can sweep. Stub's retired-queue scenario.
import http from "node:http";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStub, type Stub } from "../../../../scripts/hub-stub-server.mjs";
import type { UserQuestionPrompt, UserQuestionReply } from "../../sessions/model/userQuestion";
import { HubStore } from "../model/hubStore";
import { HubCallError, type HubTransport } from "../model/hubTransport";
import { setHubDataSource } from "../model/hubData";
import { createLiveHubData } from "../model/liveHubData";
import { noteChats, resetWaitingChats, setWaitingChatsHost } from "../model/waitingChats";
import { ProjectStrip } from "./ProjectStrip";
import { createMono, saveMonoName, saveMonoSessionId } from "../../monos/model/mono";
import { noteMonoFailures, resetMonoFailures } from "../../monos/model/monoFailures";
import { HubSurface } from "./HubSurface";

function httpTransport(baseUrl: () => string, token: () => string): HubTransport {
  return {
    call: (action, payload = {}) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request(
          `${baseUrl()}/api/${action}`,
          { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              const json = JSON.parse(raw);
              if (json.ok) resolve(json.result);
              else reject(new HubCallError("error", json.error));
            });
          },
        );
        req.on("error", () => reject(new HubCallError("unreachable", "Ash OS isn't running.")));
        req.end(body);
      }),
    openFeed: (_after, handlers) => {
      handlers.onState({ connected: false, message: "polling in this test" });
      return () => undefined;
    },
  };
}

const FAST = { coalesceMs: 5, healthMs: 20, pollMs: 40, retryMs: [40], stopGraceMs: 5 };
let stub: Stub;
let store: HubStore;
let root: Root;
let container: HTMLElement;
let calls: { respond: [string, number, UserQuestionReply][]; send: [string, string][]; open: string[] };
const live = new Map<string, UserQuestionPrompt>();

async function until(read: () => unknown, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${container.textContent}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}
const text = () => container.textContent ?? "";
const q = (s: string) => container.querySelector(s) as HTMLElement | null;
const needRows = () => [...container.querySelectorAll("[data-hub-need]")].map((r) => r.getAttribute("data-hub-need"));
const waitingRows = () => [...container.querySelectorAll("[data-hub-waiting-chat]")].map((r) => r.getAttribute("data-hub-waiting-chat"));
const badge = (name: string) => container.querySelector(`button[aria-label^="${name}"] span.hub-count-badge`)?.textContent;
const typeInto = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const ask = (requestId: number, prompt: string, pick: string, other: string): UserQuestionPrompt => ({
  requestId,
  questions: [{ id: prompt, prompt, multiSelect: false, allowCustom: true, options: [{ id: pick, label: `${pick} (Recommended)` }, { id: other, label: other }] }],
});

/** Two waiting chats: the EXO lead's live AskUserQuestion, and a Hivra chat that ended its turn with a Needs Ash line. */
function twoWaitingChats() {
  const boss = ask(4, "Which boss comes first in the demo?", "Shield", "Flier");
  live.set("exo-chat", boss);
  noteChats([
    { id: "exo-chat", cwd: "/Users/example/Projects/vg-game", title: "claude · Boss order", harness: "claude", busy: true, pendingQuestion: boss, blocks: [] },
    {
      id: "hivra-chat", cwd: "/Users/example/Projects/hivra", title: "claude · Waitlist page", harness: "claude", busy: false,
      blocks: [{ role: "user", text: "tidy the waitlist", startedAt: 1 }, { role: "assistant", text: "Tidied.\n\nNeeds Ash: Keep the old waitlist page up for returning visitors?\nMy pick: Redirect it to the new page." }],
    },
  ], Date.now() - 60_000);
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetWaitingChats();
  resetMonoFailures();
  live.clear();
  calls = { respond: [], send: [], open: [] };
  setWaitingChatsHost({
    liveQuestion: (id) => live.get(id),
    respond: (id, requestId, reply) => {
      calls.respond.push([id, requestId, reply]);
      live.delete(id);
    },
    send: async (id, words) => (calls.send.push([id, words]), true),
    open: (id) => void calls.open.push(id),
  });
  stub = await startStub({ questions: true });
  store = new HubStore({ transport: httpTransport(() => stub.url, () => stub.token), ...FAST });
  setHubDataSource(createLiveHubData(store), store);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await new Promise((r) => setTimeout(r, 20));
  store.stop();
  setHubDataSource(undefined);
  resetWaitingChats();
  await stub.close();
});

// A project is the unit of the hub (G1): each test opens the project whose rows it is about, strip and all.
const today = (project: string) =>
  createElement(
    "div",
    null,
    createElement(ProjectStrip, { selection: { project, item: "inbox" }, onPickProject: () => undefined, onCreateProject: () => undefined }),
    createElement(HubSurface, { selection: { project, item: "inbox" } }),
  );

describe("Waiting on you", () => {
  it("lists each waiting chat with its chat, one-line question and pick, above Needs you", async () => {
    twoWaitingChats();
    act(() => root.render(today("vg-game")));
    await until(() => needRows().length, "needs");
    expect(waitingRows()).toEqual(["exo-chat"]);
    const row = (id: string) => [`[data-hub-waiting-chat="${id}"] [data-hub-waiting-where]`, `[data-hub-waiting-chat="${id}"] [data-hub-waiting-question]`, `[data-hub-waiting-chat="${id}"] [data-hub-waiting-pick]`].map((s) => q(s)?.textContent);
    // Inside a project the row names the chat, not the project it already sits in.
    expect(row("exo-chat")).toEqual(["Boss order", "Which boss comes first in the demo?", "Suggests: Shield"]);
    // Waiting on you comes first; "Needs you" names the gates and failures under it
    const order = [...container.querySelectorAll("[data-hub-waiting], [data-hub-needs-heading], [data-hub-need]")].map((e) => (e.hasAttribute("data-hub-waiting") ? "waiting" : e.hasAttribute("data-hub-needs-heading") ? "needs-heading" : "need"));
    expect(order.slice(0, 3)).toEqual(["waiting", "needs-heading", "need"]);
    // The chat counts on its project's strip badge (EXO: its playtest gate plus the waiting chat)
    expect(badge("EXO")).toBe("2");
  });

  it("a project's badge counts what its Today shows, a Mono whose last turn failed included", async () => {
    twoWaitingChats();
    act(() => root.render(today("vg-game")));
    await until(() => waitingRows().length === 1, "waiting rows");
    expect(badge("EXO")).toBe("2");
    const mono = createMono(["/Users/example/Projects/vg-game"]);
    saveMonoName(mono.id, "EXO lead");
    saveMonoSessionId(mono.id, "exo-lead-chat");
    act(() =>
      noteMonoFailures([
        {
          id: "exo-lead-chat",
          busy: false,
          blocks: [
            { id: "u", role: "user", text: "status?" },
            { id: "e", role: "system", notice: "error", text: "Billing refused (402): Insufficient credits", failure: { errorClass: "billing", retryable: false } },
          ],
        },
      ]),
    );
    await until(() => q("[data-mono-failure]"), "the failed Mono on Today");
    expect(q("[data-mono-failure-line]")?.textContent).toContain("EXO lead can't answer: Out of credits");
    expect(badge("EXO")).toBe("3");
  });

  it("a project with nothing waiting shows no badge and no needs count, never \"0 needs\"", async () => {
    act(() => root.render(today("nibbii")));
    await until(() => q('[data-hub-today-section="latest-page"]'), "nibbii's Today");
    expect(needRows()).toEqual([]);
    expect(q("[data-hub-waiting]")).toBeNull();
    expect(badge("Nibbii")).toBeUndefined();
    expect(text()).not.toMatch(/\b0 needs?\b/);
  });

  it("Take the pick answers the live question in place, and the next row takes the cursor", async () => {
    twoWaitingChats();
    const next = ask(5, "Which level next?", "Area 2", "Area 3");
    live.set("exo-chat-2", next);
    noteChats(
      [{ id: "exo-chat-2", cwd: "/Users/example/Projects/vg-game", title: "claude · Level order", harness: "claude", busy: true, pendingQuestion: next, blocks: [] }],
      Date.now() - 30_000,
    );
    act(() => root.render(today("vg-game")));
    await until(() => waitingRows().length === 2, "waiting rows");
    await act(async () => q('[data-hub-waiting-chat="exo-chat"] [data-hub-take-pick]')!.click());
    expect(calls.respond).toEqual([["exo-chat", 4, { kind: "answered", answers: { "Which boss comes first in the demo?": ["Shield"] } }]]);
    await until(() => q('[data-hub-waiting-sent="exo-chat"]'), "exo ticked");
    // the next row's box took the cursor: answering in a row needs no mouse
    expect(document.activeElement).toBe(q('[data-hub-waiting-chat="exo-chat-2"] [data-hub-waiting-reply]'));
    expect(text()).toContain("Boss order: Shield");
    expect(badge("EXO")).toBe("2"); // its playtest gate plus the chat still waiting
  });

  it("a reply in Ash's words goes into that chat, and the row ticks off", async () => {
    twoWaitingChats();
    act(() => root.render(today("hivra")));
    await until(() => waitingRows().length === 1, "waiting rows");
    const input = q('[data-hub-waiting-chat="hivra-chat"] [data-hub-waiting-reply]') as HTMLInputElement;
    typeInto(input, "Keep it a month, then redirect");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(() => q('[data-hub-waiting-sent="hivra-chat"]'), "hivra ticked");
    expect(calls.send).toEqual([["hivra-chat", "Keep it a month, then redirect"]]);
    expect(text()).toContain("Waitlist page: Keep it a month, then redirect");
    expect(badge("Hivra")).toBe("1"); // its red-line gate, the chat no longer waiting
  });

  it("Take all N picks clears every waiting chat with a pick, but never a red line", async () => {
    twoWaitingChats();
    noteChats([
      { id: "hivra-chat-2", cwd: "/Users/example/Projects/hivra", title: "claude · Waitlist footer", harness: "claude", busy: false, blocks: [{ role: "assistant", text: "Needs Ash: Ship the waitlist footer today?\nMy pick: Wait for the next deploy." }] },
      { id: "red-chat", cwd: "/Users/example/Projects/hivra", title: "claude · Waitlist email", harness: "claude", busy: false, blocks: [{ role: "assistant", text: "Needs Ash (red line): Email the waitlist today?\nMy pick: Wait until Friday." }] },
    ], Date.now() - 30_000);
    act(() => root.render(today("hivra")));
    await until(() => waitingRows().length === 3, "three waiting");
    expect(q('[data-hub-waiting-chat="red-chat"] [data-hub-red-line]')?.textContent).toBe("Red line");
    expect(q("[data-hub-take-all]")?.textContent).toBe("Take all 2 picks");
    await act(async () => q("[data-hub-take-all]")!.click());
    await until(() => container.querySelectorAll("[data-hub-waiting-sent]").length === 2, "two cleared");
    expect(waitingRows()).toEqual(["red-chat"]);
    expect(calls.respond).toEqual([]);
    expect(calls.send.map(([id]) => id)).toEqual(["hivra-chat", "hivra-chat-2"]);
  });

  it("Open hands the chat to the app", async () => {
    twoWaitingChats();
    act(() => root.render(today("hivra")));
    await until(() => waitingRows().length === 1, "waiting rows");
    act(() => q('[data-hub-waiting-chat="hivra-chat"] [data-hub-open-chat]')!.click());
    expect(calls.open).toEqual(["hivra-chat"]);
  });

  it("a project's Inbox shows only its own waiting chats", async () => {
    twoWaitingChats();
    act(() => root.render(createElement(HubSurface, { selection: { project: "hivra", item: "inbox" } })));
    await until(() => waitingRows().length, "waiting rows");
    expect(waitingRows()).toEqual(["hivra-chat"]);
    expect(q('[data-hub-waiting-chat="hivra-chat"] [data-hub-waiting-where]')?.textContent).toBe("Waitlist page");
  });
});

describe("Needs you, a project at a time", () => {
  it("keeps only gates and failures: each project's ordinary questions are under its own Older questions", async () => {
    act(() => root.render(today("vg-game")));
    await until(() => needRows().length, "needs");
    expect(needRows()).toEqual(["q1"]); // a playtest gate
    expect(q("[data-hub-older] > button")?.textContent).toBe("Older questions (3)");
    expect(q("[data-hub-waiting]")).toBeNull(); // no chat is waiting: no section

    act(() => root.render(today("hivra")));
    await until(() => needRows().join() === "q:r1", "hivra's needs");
    expect(q("[data-hub-older] > button")?.textContent).toBe("Older questions (3)");

    act(() => root.render(today("hub")));
    await until(() => needRows().length === 5, "hub's needs");
    expect(needRows()).toEqual(["q:f1", "q4", "q5", "q6", "q8"]); // a failure still failing, then its asks
    expect(q("[data-hub-older] > button")?.textContent).toBe("Older questions (4)");
    for (const id of ["q:q2", "q:q3", "q:q7", "q:q9"]) expect(needRows()).not.toContain(id);
  });
});

describe("Older questions", () => {
  it("is one quiet line; opened, Ash dismisses the project's oldest in one go (asks parked, not dropped)", async () => {
    act(() => root.render(today("hub")));
    await until(() => q("[data-hub-older]"), "older");
    const toggle = q("[data-hub-older] > button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("From the old question queue");
    act(() => toggle.click());
    expect(q("[data-hub-older-note]")?.textContent).toContain("nothing new is added here");
    // 3 days: this project's backlog asked 6 and 33 days ago (2), not the ones from today or another project's
    expect(q("[data-hub-older-dismiss]")?.textContent).toBe("Dismiss 2");
    act(() => q("[data-hub-older-dismiss]")!.click());
    expect(text()).toContain("Their asks are parked, not dropped");
    await act(async () => q("[data-hub-older-confirm]")!.click());
    await until(() => q("[data-hub-older-receipt]"), "receipt");
    expect(q("[data-hub-older-receipt]")?.textContent).toBe("Dismissed 2 older questions. Their asks are parked: saying one again brings it back. 2 still waiting.");
    await until(() => q("[data-hub-older] > button")?.textContent === "Older questions (2)", "count drops");
    expect(stub.calls.find((c) => c.path === "/api/ash-hub-older-dismiss")).toBeTruthy();
  });

  it("each older question still opens its sheet to be answered", async () => {
    act(() => root.render(today("hivra")));
    await until(() => q("[data-hub-older]"), "older");
    act(() => q("[data-hub-older] > button")!.click());
    expect(q('[data-hub-need="q:q3"]')).toBeTruthy();
    expect(text()).toContain("Example: pick the waitlist headline");
  });
});
