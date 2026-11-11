// @vitest-environment happy-dom
// Dropwave (Ash, 11 Nov): "a first mate can have multiple chats". "New chat" beside a first mate's chat starts a further
// chat with that same first mate; its row on the rail still opens its main chat.
import { beforeEach, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";

vi.mock("../../../platform/tauri/fs", () => ({ homeDir: async () => "/Users/ash" }));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function setup() {
  const mono = await import("./mono");
  mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "gray", projects: [] });
  mono.addMono({ id: "ed", name: "Ed", mascot: "robot", color: "gray", projects: [] });
  const workspace = await import("./monoWorkspace");
  const sessions: Session[] = [];
  const host = {
    home: async () => "/Users/ash",
    load: async (id: string) => sessions.find((s) => s.id === id),
    create: (cwd: string) => newSession("claude", cwd),
    add: (s: Session) => void sessions.push(s),
  };
  return { mono, workspace, sessions, host };
}

it("starts a further chat that belongs to the same first mate and leaves its main chat alone", async () => {
  const { mono, workspace, sessions, host } = await setup();
  const main = await workspace.ensureMonoSession("ada", host);
  const side = await workspace.startMonoSideChat("ada", host, "/code/hivra");
  expect(side).toBeDefined();
  expect(side!.id).not.toBe(main!.id);
  expect(side!.cwd).toBe("/code/hivra");
  expect(side!.firstMate).toBe(true);
  expect(sessions.map((s) => s.id)).toEqual([main!.id, side!.id]);
  expect(mono.findMono("ada")?.sessionId).toBe(main!.id);
  expect(mono.findMono("ada")?.chats).toEqual([side!.id]);
  expect(mono.monoForSession(side!.id)?.id).toBe("ada");
  expect(mono.isMonoSideChat(side!.id)).toBe(true);
  expect(mono.isMonoSideChat(main!.id)).toBe(false);
  // A second one is a third conversation, not the same one again.
  const again = await workspace.startMonoSideChat("ada", host);
  expect(again!.id).not.toBe(side!.id);
  expect(again!.cwd).toBe("/Users/ash");
  expect(mono.findMono("ada")?.chats).toEqual([side!.id, again!.id]);
});

it("never takes another first mate's chat, and forgets a further chat that was deleted", async () => {
  const { mono, workspace, host } = await setup();
  const edMain = await workspace.ensureMonoSession("ed", host);
  expect(mono.saveMonoSideChat("ada", edMain!.id)).toBe(false);
  expect(mono.findMono("ada")?.chats).toBeUndefined();
  const side = await workspace.startMonoSideChat("ada", host);
  mono.forgetMonoSideChat(side!.id);
  expect(mono.findMono("ada")?.chats).toBeUndefined();
  expect(mono.monoForSession(side!.id)).toBeUndefined();
  // The main chat is not a further chat, so forgetting it changes nothing.
  mono.forgetMonoSideChat(edMain!.id);
  expect(mono.findMono("ed")?.sessionId).toBe(edMain!.id);
});

it("drops a hand-edited list's bad ids and the main chat's own id", async () => {
  const { mono } = await setup();
  const main = "main-1";
  mono.saveMonoSessionId("ada", main);
  const stored = Object.keys(localStorage).find((key) => (localStorage.getItem(key) ?? "").includes('"ada"'));
  expect(stored).toBeDefined();
  const roster = JSON.parse(localStorage.getItem(stored!)!);
  const list = Array.isArray(roster) ? roster : roster.monos;
  const ada = list.find((entry: { id: string }) => entry.id === "ada");
  ada.chats = ["side-1", main, "../etc", 7, "side-1"];
  localStorage.setItem(stored!, JSON.stringify(roster));
  vi.resetModules();
  const fresh = await import("./mono");
  expect(fresh.findMono("ada")?.chats).toEqual(["side-1"]);
});
