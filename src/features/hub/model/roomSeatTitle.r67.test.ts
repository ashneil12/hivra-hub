// @vitest-environment happy-dom
// r67: the Working tray titled room seats with their raw prompt ("You are Ed, in the group
// chat \"Leadership team\"…"). A room seat's session reads as the Mono and the room.
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

it("a room seat's session is 'Ed · Leadership team'; any other session has no seat title", async () => {
  const { addMono } = await import("../../monos/model/mono");
  addMono({ id: "ada", name: "Ada", mascot: "robot", color: "gray", projects: [] });
  addMono({ id: "ed", name: "Ed", mascot: "robot", color: "gray", projects: [] });
  const chat = await import("./hubChats");
  const mono = await import("../../monos/model/mono");
  const { roomSeatTitle } = await import("./roomSeatTitle");
  const c = chat.createChat("hub", "Leadership team", ["ada", "ed"]);
  expect(mono.saveMonoRoomSession("ed", c.id, "conv-1", "s-room-ed")).toBe(true);
  const name = mono.monoLook(mono.findMono("ed")!).name;
  expect(roomSeatTitle("s-room-ed")).toBe(`${name} · Leadership team`);
  expect(roomSeatTitle("s-room-ed")).not.toMatch(/You are/);
  expect(roomSeatTitle("some-worker")).toBeUndefined();
});
