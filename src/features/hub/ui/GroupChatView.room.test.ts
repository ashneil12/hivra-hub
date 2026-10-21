// @vitest-environment happy-dom
// The room on screen, in its existing look: who is working instead of filler bubbles, Stop while the team works and
// Keep going once it paused, a notice with Try again when a Mono couldn't answer, reactions instead of "got it".
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The composer needs the app's window (file drops); the room's own screen is what is under test.
vi.mock("../../monos/ui/MonoComposer", () => ({ MonoComposer: () => null }));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  const team = await import("../model/builtInMonos");
  team.ensureBuiltInMonos();
  const chat = await import("../model/hubChats");
  const { GroupChatView } = await import("./GroupChatView");
  const room = chat.createChat("hub", "Leadership Board", ["chief-of-staff", "projects-manager", "frank"]);
  const conv = chat.startConversation(room.id, "what now?");
  const show = () => act(() => root.render(createElement(GroupChatView, { chatId: room.id, projectId: "hub" })));
  show();
  return { chat, room, conv, show, q: (sel: string) => container.querySelector(sel) as HTMLElement | null };
}

it("shows who is writing with a Stop, and after Stop the team waits with Keep going", async () => {
  const { chat, room, conv, q } = await render();
  let stopped = false;
  chat.setGroupChatRunner({
    run: () => new Promise((_, reject) => setInterval(() => stopped && reject(new Error("stopped")), 5)),
    stop: () => {
      stopped = true;
    },
  });
  await act(async () => {
    void chat.requestReply(room.id, conv);
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(q("[data-hub-typing]")!.textContent).toContain("Chief of Staff is writing…");
  expect(q("[data-hub-member-working]")!.textContent).toContain("Chief of Staff");
  await act(async () => {
    q("[data-hub-room-stop]")!.click();
    await new Promise((r) => setTimeout(r, 30));
  });
  // The pause is the quiet strip above the composer, not a line posted in the room (AD6, AD12).
  expect(q("[data-hub-msg-system]")).toBeNull();
  expect(q("[data-hub-room-strip]")!.textContent).toBe("You stopped the room. The team waits for you.");
  expect(q("[data-hub-room-keep-going]")).toBeTruthy();
}, 20_000);

it("a notice says which Mono couldn't answer, with Try again; reactions show under the message, and Ash can add his", async () => {
  const { chat, room, conv, q } = await render();
  chat.setGroupChatRunner(async () => {
    throw new Error("You've hit your usage limit. Resets at 4pm.");
  });
  await act(async () => {
    await chat.requestReply(room.id, conv);
  });
  const notice = q("[data-hub-msg-notice]")!;
  expect(notice.textContent).toContain("Chief of Staff couldn't answer: You've hit your usage limit. Resets at 4pm.");
  // The host names frank, so he answers it; the other seats' one turns have nothing to add.
  chat.setGroupChatRunner(async (mono) => (mono === "chief-of-staff" ? "Next: the Pages round. frank, check it." : mono === "frank" ? "Got it." : "NO_REPLY"));
  await act(async () => {
    q("[data-hub-notice-retry]")!.click();
    await chat.roomIdle(room.id);
  });
  expect(q("[data-hub-notice-retry]")).toBeNull();
  expect(container.textContent).toContain("Next: the Pages round. frank, check it.");
  // frank's "Got it." became a 👍 on the host's message, not a bubble.
  expect(container.textContent).not.toContain("Got it.");
  expect(q("[data-hub-msg-reactions]")!.textContent).toBe("👍frank");
  await act(async () => {
    (container.querySelector('[data-hub-react="✅"]') as HTMLElement).click();
  });
  expect([...container.querySelectorAll("[data-hub-msg-reactions]")].map((x) => x.textContent)).toContain("👍frank✅You");
}, 20_000);

it("the host's answer fills in where it will stay: a live message while it writes, the same message once it lands", async () => {
  const { chat, room, conv, q } = await render();
  let write!: (text: string) => void;
  let end!: (text: string) => void;
  chat.setGroupChatRunner({
    run: (request) => {
      // The other seats' one turns have nothing to add.
      if (request.monoId !== "chief-of-staff") return Promise.resolve({ kind: "reply", text: "NO_REPLY" });
      write = (text) => request.onText?.(text);
      return new Promise((resolve) => (end = (text) => resolve({ kind: "reply", text })));
    },
  });
  await act(async () => {
    void chat.requestReply(room.id, conv);
    await new Promise((r) => setTimeout(r, 10));
  });
  // Not started yet: the line above the composer says so.
  expect(q("[data-hub-typing]")!.textContent).toContain("Chief of Staff is writing…");
  await act(async () => write("Heard you. Waiting on the Tally lead's start-ack."));
  const live = q("[data-hub-msg-draft]")!;
  expect(live.textContent).toContain("Chief of Staff");
  expect(live.textContent).toContain("Heard you. Waiting on the Tally lead's start-ack.");
  // Its words are on screen, so the line doesn't repeat that it is writing.
  expect(q("[data-hub-typing]")!.textContent).not.toContain("Chief of Staff is writing");
  await act(async () => {
    end("Heard you. Waiting on the Tally lead's start-ack. Nothing needs you.");
    await chat.roomIdle(room.id);
  });
  expect(q("[data-hub-msg-draft]")).toBeNull();
  // The same element, now the message: it filled in rather than being replaced.
  expect(live.isConnected).toBe(true);
  expect(live.textContent).toContain("Nothing needs you.");
}, 20_000);

it("a long post shows its first lines with Show more; a short one shows whole", async () => {
  const { chat, room, conv, q } = await render();
  const long = ["Heard you: seven things for this week.", "", ...Array.from({ length: 14 }, (_, i) => `${i + 1}. Item ${i + 1} with its owner and what done looks like.`)].join("\n");
  chat.setGroupChatRunner(async (mono) => (mono === "chief-of-staff" ? long : "NO_REPLY"));
  await act(async () => {
    await chat.requestReply(room.id, conv);
    await chat.roomIdle(room.id);
  });
  const folded = q("[data-hub-msg-folded]")!;
  expect(folded.textContent).toContain("Heard you: seven things");
  expect(folded.textContent).not.toContain("Item 14");
  await act(async () => q("[data-hub-msg-more]")!.click());
  expect(container.textContent).toContain("Item 14 with its owner");
  expect(q("[data-hub-msg-more]")!.textContent).toBe("Show less");
}, 20_000);
