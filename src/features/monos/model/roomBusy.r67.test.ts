// @vitest-environment happy-dom
// r67 (Alfred's r66 A9): during room-only turns every Mono row read "idle" and the folded Monos header said nothing,
// while the seats wrote in the Leadership room. A Mono writing a room turn reads busy, with the room's name.
import { beforeEach, expect, it, vi } from "vitest";
import type { MonoState } from "./mono";
import { withRoomTurns } from "./roomBusy";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

it("an idle Mono on a room turn reads working, in that room; its own chat's state wins otherwise", () => {
  const states = new Map<string, MonoState>([
    ["ed", { status: "idle" }],
    ["hub-lead", { status: "working", activity: "Reading app.tsx" }],
  ]);
  const turns = new Map([["ed", "c1"], ["hub-lead", "c1"], ["cam", "c1"]]);
  const out = withRoomTurns(states, turns, (id) => (id === "c1" ? "Leadership team" : undefined));
  expect(out.get("ed")).toEqual({ status: "working", activity: "In Leadership team" });
  expect(out.get("cam")).toEqual({ status: "working", activity: "In Leadership team" });
  expect(out.get("hub-lead")).toEqual({ status: "working", activity: "Reading app.tsx" });
  expect(withRoomTurns(states, new Map(), () => "x")).toBe(states);
});

it("the conductor lists the Monos writing a room turn, and nobody once it is done", async () => {
  const team = await import("../../hub/model/builtInMonos");
  team.ensureBuiltInMonos();
  const chat = await import("../../hub/model/hubChats");
  const c = chat.createChat("hub", "Leadership team", ["ada", "ed"]);
  const during: string[][] = [];
  chat.setGroupChatRunner({
    run: async () => {
      during.push([...chat.roomTurnsByMono().entries()].map(([m, id]) => `${m}@${id === c.id ? "room" : id}`));
      await new Promise((r) => setTimeout(r, 1));
      return { kind: "reply", text: "NO_REPLY" };
    },
    stop: () => undefined,
  });
  const conv = chat.startConversation(c.id, "hey team");
  await chat.requestReply(c.id, conv);
  expect(during.flat()).toContain("ada@room");
  expect(chat.roomTurnsByMono().size).toBe(0);
});
