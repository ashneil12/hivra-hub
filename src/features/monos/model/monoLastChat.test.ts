// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { createMono, findMono, updateMono, type Mono } from "./mono";
import { noteMonoChat, pickMonoChat } from "./monoLastChat";

let lead: Mono;

beforeEach(() => {
  localStorage.clear();
  const made = createMono();
  updateMono(made.id, (m) => ({ ...m, sessionId: "main", chats: ["side-a", "side-b"], projectSessions: { p1: "proj" } }));
  lead = findMono(made.id)!;
});

const sessions = [
  { id: "main", updatedAt: 10, cwd: "/work/team" },
  { id: "side-a", updatedAt: 50, cwd: "/work/team" },
  { id: "side-b", updatedAt: 30, cwd: "/work/team" },
  { id: "proj", updatedAt: 5, cwd: "/work/p1" },
];

it("opens the newest chat when none was remembered, not the first one", () => {
  expect(pickMonoChat(lead, undefined, sessions)).toBe("side-a");
});

it("opens the chat Ash was last on", () => {
  noteMonoChat("side-b");
  expect(pickMonoChat(lead, undefined, sessions)).toBe("side-b");
  noteMonoChat("main");
  expect(pickMonoChat(lead, undefined, sessions)).toBe("main");
});

it("forgets a remembered chat that is no longer the first mate's", () => {
  noteMonoChat("side-b");
  updateMono(lead.id, (m) => ({ ...m, chats: ["side-a"] }));
  expect(pickMonoChat(findMono(lead.id)!, undefined, sessions)).toBe("side-a");
});

it("keeps a project's own chat apart from Home", () => {
  noteMonoChat("proj");
  expect(pickMonoChat(lead, undefined, sessions)).toBe("side-a");
  noteMonoChat("side-b", { monoId: lead.id, project: "p1" });
  expect(pickMonoChat(lead, "p1", sessions)).toBe("side-b");
});

it("only counts further chats in the folder the list shows", () => {
  expect(pickMonoChat(lead, "p1", sessions, "/work/p1")).toBe("proj");
});

it("ignores a chat that is not one of its own", () => {
  noteMonoChat("someone-else");
  expect(pickMonoChat(lead, undefined, sessions)).toBe("side-a");
});
