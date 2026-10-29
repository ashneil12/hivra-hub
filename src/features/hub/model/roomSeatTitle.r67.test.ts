// @vitest-environment happy-dom
// r67 (Alfred's r66 rechecks): the Working tray titled room seats with their raw prompt ("You are frank, in the group
// chat \"Leadership team\"…"). A room seat's session reads as the Mono and the room.
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  vi.resetModules();
});

it("a room seat's session is 'frank · Leadership team'; any other session has no seat title", async () => {
  const team = await import("./builtInMonos");
  team.ensureBuiltInMonos();
  const chat = await import("./hubChats");
  const mono = await import("../../monos/model/mono");
  const { roomSeatTitle } = await import("./roomSeatTitle");
  const c = chat.createChat("hub", "Leadership team", ["chief-of-staff", "frank"]);
  expect(mono.saveMonoRoomSession("frank", c.id, "conv-1", "s-room-frank")).toBe(true);
  const name = mono.monoLook(mono.findMono("frank")!).name;
  expect(roomSeatTitle("s-room-frank")).toBe(`${name} · Leadership team`);
  expect(roomSeatTitle("s-room-frank")).not.toMatch(/You are/);
  expect(roomSeatTitle("some-worker")).toBeUndefined();
});
