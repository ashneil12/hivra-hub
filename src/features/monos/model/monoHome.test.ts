// @vitest-environment happy-dom
// The Monos' roster and chat ids move out of the WebView into their home (monoHome.ts); the home is a stand-in for the
// Rust mono_roster_* and mono_read / mono_save commands.
import { beforeEach, describe, expect, it } from "vitest";
import {
  hydrateRosterFromHome,
  recordMonoChat,
  resetHomeForTests,
  ROSTER_KEY,
  ROSTER_SAVED_AT_KEY,
  rosterWritesSettled,
  setHomeBackend,
  type HomeBackend,
} from "./monoHome";
import {
  addMono,
  findMono,
  isMonoSideChat,
  listMonos,
  monoForSession,
  monoProjectSession,
  monoRoomSession,
  monoSessionProject,
  saveMonoProjectSession,
  saveMonoRoomSession,
  saveMonoSessionId,
  saveMonoSideChat,
  updateMono,
} from "./mono";

/** MONOS.json and each Mono's chats.json, as the app's commands keep them (hash-checked, like mono.rs). */
function fakeHome() {
  const files = new Map<string, string>();
  const hash = (text: string | undefined) => `h:${text ?? ""}`;
  const saves: string[] = [];
  const backend: HomeBackend = {
    loadRoster: async () => ({ text: files.get("MONOS.json") ?? null, hash: hash(files.get("MONOS.json")) }),
    saveRoster: async (text) => {
      files.set("MONOS.json", text);
      saves.push(text);
      return hash(text);
    },
    readChats: async (id) => ({ text: files.get(`${id}/chats.json`) ?? null, hash: hash(files.get(`${id}/chats.json`)) }),
    saveChats: async (id, text, expected) => {
      if (hash(files.get(`${id}/chats.json`)) !== expected) throw "conflict";
      files.set(`${id}/chats.json`, text);
      return hash(text);
    },
  };
  const roster = () => JSON.parse(files.get("MONOS.json") ?? "null") as { savedAt: number; monos: { id: string; sessionId?: string }[] } | null;
  const chats = (id: string) => JSON.parse(files.get(`${id}/chats.json`) ?? "null") as { main?: string; history: string[] } | null;
  return { files, backend, roster, chats, saves };
}

const COS = { id: "ada", name: "Chief of Staff", mascot: "letter", color: "x", projects: [], sessionId: "df9afb39" };
const FRANK = { id: "ed", name: "ed", mascot: "letter", color: "x", projects: [], sessionId: "2f89e6f4" };

beforeEach(() => {
  localStorage.clear();
  setHomeBackend(undefined);
  resetHomeForTests(false);
});

describe("the Monos' roster lives in their home, not only in the WebView", () => {
  it("imports the WebView's roster into MONOS.json on the first launch after the move, chat ids included", async () => {
    localStorage.setItem(ROSTER_KEY, JSON.stringify([COS, FRANK]));
    const home = fakeHome();
    setHomeBackend(home.backend);
    resetHomeForTests(true);
    expect(await hydrateRosterFromHome()).toBe("imported");
    expect(home.roster()!.monos.map((m) => [m.id, m.sessionId])).toEqual([
      ["ada", "df9afb39"],
      ["ed", "2f89e6f4"],
    ]);
    // And each Mono's own chats.json has its chat.
    expect(home.chats("ada")).toEqual({ main: "df9afb39", history: [] });
    expect(home.chats("ed")).toEqual({ main: "2f89e6f4", history: [] });
  });

  it("survives the WebView forgetting everything: the Monos come back with their chats", async () => {
    const home = fakeHome();
    home.files.set("MONOS.json", JSON.stringify({ version: 1, savedAt: 100, monos: [COS, FRANK] }));
    setHomeBackend(home.backend);
    resetHomeForTests(false); // WebKit was reset: no roster at launch
    expect(listMonos()).toEqual([]);
    expect(await hydrateRosterFromHome()).toBe("restored");
    expect(listMonos().map((m) => [m.id, m.sessionId])).toEqual([
      ["ada", "df9afb39"],
      ["ed", "2f89e6f4"],
    ]);
  });

  it("keeps a Mono made after the reset but before the file was read, and never gives it another Mono's chat", async () => {
    const home = fakeHome();
    home.files.set("MONOS.json", JSON.stringify({ version: 1, savedAt: 100, monos: [COS] }));
    setHomeBackend(home.backend);
    resetHomeForTests(false);
    // The rail repaired the team on first render, into the empty WebView: same id as the file, no chat yet; plus a
    // new one that somehow names CoS's chat.
    addMono({ id: "ada", name: "Chief of Staff", mascot: "letter", color: "x", projects: [] });
    addMono({ id: "cam", name: "Alfred", mascot: "letter", color: "x", projects: [], sessionId: "df9afb39" } as never);
    expect(await hydrateRosterFromHome()).toBe("merged");
    const monos = listMonos();
    expect(monos.map((m) => m.id)).toEqual(["ada", "cam"]);
    expect(monos[0].sessionId).toBe("df9afb39");
    expect(monos[1].sessionId).toBeUndefined();
    expect(home.roster()!.monos.map((m) => m.id)).toEqual(["ada", "cam"]);
  });

  it("writes every roster change through to MONOS.json once the launch reconcile is done", async () => {
    localStorage.setItem(ROSTER_KEY, JSON.stringify([COS]));
    localStorage.setItem(ROSTER_SAVED_AT_KEY, "50");
    const home = fakeHome();
    home.files.set("MONOS.json", JSON.stringify({ version: 1, savedAt: 50, monos: [COS] }));
    setHomeBackend(home.backend);
    resetHomeForTests(true);
    // A change before the reconcile waits for it (never a half-read file overwritten).
    updateMono("ada", (m) => ({ ...m, name: "CoS" }));
    expect(home.saves).toEqual([]);
    expect(await hydrateRosterFromHome()).toBe("saved");
    updateMono("ada", (m) => ({ ...m, name: "Chief of Staff" }));
    await rosterWritesSettled();
    expect(home.roster()!.monos[0]).toMatchObject({ id: "ada", name: "Chief of Staff" });
  });

  it("takes a newer file over an older cache", async () => {
    localStorage.setItem(ROSTER_KEY, JSON.stringify([COS]));
    localStorage.setItem(ROSTER_SAVED_AT_KEY, "50");
    const home = fakeHome();
    home.files.set("MONOS.json", JSON.stringify({ version: 1, savedAt: 90, monos: [COS, FRANK] }));
    setHomeBackend(home.backend);
    resetHomeForTests(true);
    expect(await hydrateRosterFromHome()).toBe("file-newer");
    expect(listMonos().map((m) => m.id)).toEqual(["ada", "ed"]);
  });

  it("is off outside the app: nothing is read or written", async () => {
    expect(await hydrateRosterFromHome()).toBe("off");
    expect(await recordMonoChat("ed", "x")).toBe(false);
  });
});

describe("chat ids move out of the WebView into each Mono's chats.json", () => {
  it("records the new chat and keeps the old one under history", async () => {
    localStorage.setItem(ROSTER_KEY, JSON.stringify([COS]));
    const home = fakeHome();
    setHomeBackend(home.backend);
    resetHomeForTests(true);
    await hydrateRosterFromHome();
    saveMonoSessionId("ada", "fresh-chat");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(home.chats("ada")).toEqual({ main: "fresh-chat", history: ["df9afb39"] });
    // The same chat again changes nothing.
    expect(await recordMonoChat("ada", "fresh-chat")).toBe(false);
  });
});

describe("G1: a first mate's further chats, its project chats and its team-chat seats survive a relaunch", () => {
  async function savedWithEveryKindOfChat() {
    localStorage.setItem(ROSTER_KEY, JSON.stringify([COS, FRANK]));
    const home = fakeHome();
    setHomeBackend(home.backend);
    resetHomeForTests(true);
    await hydrateRosterFromHome();
    expect(saveMonoSideChat("ada", "side-2")).toBe(true);
    expect(saveMonoSideChat("ada", "side-3")).toBe(true);
    expect(saveMonoProjectSession("ada", "hivra", "cos-hivra")).toBe(true);
    expect(saveMonoProjectSession("ada", "vg-game", "cos-vg")).toBe(true);
    expect(saveMonoRoomSession("ed", "team-1", "conv-1", "ed-room")).toBe(true);
    await rosterWritesSettled();
    return home;
  }

  function expectEveryChatKept() {
    expect(findMono("ada")).toMatchObject({
      sessionId: "df9afb39",
      chats: ["side-2", "side-3"],
      projectSessions: { hivra: "cos-hivra", "vg-game": "cos-vg" },
    });
    expect(monoForSession("side-2")?.id).toBe("ada");
    expect(isMonoSideChat("side-3")).toBe(true);
    expect(monoProjectSession("ada", "hivra")).toBe("cos-hivra");
    expect(monoSessionProject("cos-vg")).toBe("vg-game");
    expect(monoRoomSession("ed", "team-1", "conv-1")).toBe("ed-room");
    expect(findMono("ed")?.sessionId).toBe("2f89e6f4");
  }

  it("writes them to MONOS.json with the rest of the Mono", async () => {
    const home = await savedWithEveryKindOfChat();
    const ada = home.roster()!.monos.find((m) => m.id === "ada") as Record<string, unknown>;
    expect(ada.chats).toEqual(["side-2", "side-3"]);
    expect(ada.projectSessions).toEqual({ hivra: "cos-hivra", "vg-game": "cos-vg" });
    const ed = home.roster()!.monos.find((m) => m.id === "ed") as Record<string, unknown>;
    expect(Object.values(ed.roomSessions as Record<string, string>)).toEqual(["ed-room"]);
  });

  it("keeps them when the window's roster is read back from its saved text", async () => {
    await savedWithEveryKindOfChat();
    const saved = localStorage.getItem(ROSTER_KEY)!;
    localStorage.clear();
    localStorage.setItem(ROSTER_KEY, saved);
    resetHomeForTests(true);
    expectEveryChatKept();
  });

  it("brings them back from MONOS.json when the WebView forgot everything", async () => {
    const home = await savedWithEveryKindOfChat();
    // A relaunch after a WebKit reset: the window starts with no roster at all, MONOS.json is all there is.
    localStorage.clear();
    setHomeBackend(home.backend);
    resetHomeForTests(false);
    expect(listMonos()).toEqual([]);
    expect(await hydrateRosterFromHome()).toBe("restored");
    expectEveryChatKept();
  });

  it("takes them from a newer MONOS.json over an older window copy that lacks them", async () => {
    const home = await savedWithEveryKindOfChat();
    // Another window saved them later than this one's cache.
    localStorage.setItem(ROSTER_KEY, JSON.stringify([COS, FRANK]));
    localStorage.setItem(ROSTER_SAVED_AT_KEY, "1");
    setHomeBackend(home.backend);
    resetHomeForTests(true);
    expect(await hydrateRosterFromHome()).toBe("file-newer");
    expectEveryChatKept();
  });
});
