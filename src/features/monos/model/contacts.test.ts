// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { findMono, listMonos, removeMono, updateMono } from "./mono";
import {
  CONTACT_SAVE_LOST,
  contactRows,
  contactWriteResult,
  duplicateContact,
  duplicateContactFiles,
  duplicateContactWithFiles,
  editContactProfile,
  listContactRows,
  newContact,
  newContactFromTemplate,
  removeContact,
  setContactMuted,
  setContactPinned,
} from "./contacts";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
});

function seed(name: string, extra: Record<string, unknown> = {}) {
  const mono = newContact(["/work/My Project", "/work/My Project"]);
  updateMono(mono.id, (current) => ({ ...current, name, ...extra }));
  return findMono(mono.id)!;
}

it("lists name, title, one last line and unread, pinned first, mute hiding the badge", () => {
  const ada = seed("Ada", { role: "Design review", pinned: true });
  const milo = seed("Milo", { role: "Notes", muted: true });
  const noName = newContact();
  const rows = contactRows(listMonos(), {
    [ada.id]: { lastLine: "The screen is crowded.\r\nsecret second line", unread: 2 },
    [milo.id]: { lastLine: "  hello\u0000 there  ", unread: 4 },
    [noName.id]: { lastLine: "", unread: "3" },
  });
  expect(rows.map((row) => row.name)).toEqual(["Ada", "Milo", rows[2]!.name]);
  expect(rows[0]).toMatchObject({ title: "Design review", lastLine: "The screen is crowded.", unread: 2, pinned: true });
  expect(rows[1]).toMatchObject({ title: "Notes", lastLine: "hello there", unread: 0, muted: true });
  expect(rows[2]?.lastLine).toBe("No messages yet");
  expect(rows[2]?.unread).toBe(0);
  expect(contactRows([], {})).toEqual([]);
});

it("drops a bad pin, a bad mute and a bad unread, and caps the badge", () => {
  const raw = JSON.parse(localStorage.getItem("monocode:mono-roster") ?? "[]") as Record<string, unknown>[];
  raw.push({ id: "../etc", name: "Bad", mascot: "dino", color: "x", projects: [], pinned: true });
  raw.push({ id: "ok-id", name: "Ok", mascot: "dino", color: "x", projects: ["C:\\work files\\notes"], pinned: "yes", muted: 1 });
  localStorage.setItem("monocode:mono-roster", JSON.stringify(raw));
  const rows = listContactRows({ "ok-id": { unread: 150.9, lastLine: "a\r\nb" } });
  expect(rows.some((row) => row.id.includes(".."))).toBe(false);
  const ok = rows.find((row) => row.id === "ok-id");
  expect(ok).toMatchObject({ pinned: false, muted: false, unread: 99, lastLine: "a" });
  expect(ok && listMonos().find((mono) => mono.id === ok.id)?.projects).toEqual(["C:\\work files\\notes"]);
});

it("pins, mutes, edits and removes one contact without touching another", () => {
  const ada = seed("Ada", { role: "Design review" });
  const milo = seed("Milo");
  expect(setContactPinned(ada.id, true)?.pinned).toBe(true);
  expect(setContactPinned("..", true)).toBeUndefined();
  expect(findMono(milo.id)?.pinned).toBeUndefined();
  removeMono(ada.id);
  expect(setContactMuted(ada.id, true)).toBeUndefined();
  expect(setContactPinned(milo.id, true)?.id).toBe(milo.id);
  const renamed = editContactProfile(milo.id, { name: "Milo\r\n<script>", title: "x".repeat(80) });
  expect(renamed?.name).toBe("Milo <script>");
  expect(renamed?.role).toHaveLength(40);
  expect(editContactProfile("../milo", { name: "nope" })).toBeUndefined();
  expect(removeContact(milo.id)).toBe(true);
  expect(findMono(milo.id)).toBeUndefined();
  expect(removeContact(milo.id)).toBe(false);
  expect(removeContact("..\\windows")).toBe(false);
});

it("duplicates the profile and not the chat, and does not write the original's files", async () => {
  const ada = seed("Ada", { role: "Design review", sessionId: "chat-ada", instructions: "Care about screens." });
  setContactPinned(ada.id, true);
  setContactMuted(ada.id, true);
  const copy = duplicateContact(ada.id);
  expect(copy?.id).not.toBe(ada.id);
  expect(copy?.sessionId).toBeUndefined();
  expect(copy?.name).toBe("Ada copy");
  expect(copy?.role).toBe("Design review");
  expect(copy?.pinned).toBeUndefined();
  expect(copy?.projects).toEqual(["/work/My Project"]);
  expect(findMono(ada.id)?.sessionId).toBe("chat-ada");
  expect(duplicateContact(ada.id)?.name).toBe("Ada copy");
  expect(duplicateContact("..")).toBeUndefined();
  expect(duplicateContact("missing")).toBeUndefined();

  const writes: [string, string][] = [];
  const skipped = await duplicateContactFiles(ada.id, ada.id, {
    read: async () => "soul",
    write: async (id, name) => {
      writes.push([id, name]);
      return true;
    },
  });
  expect(skipped).toBe("skipped");
  expect(writes).toEqual([]);
  const copied = await duplicateContactFiles(ada.id, copy!.id, {
    read: async (id, name) => (id === ada.id && name === "SOUL.md" ? "edited soul\r\n" : null),
    write: async (id, name, text) => {
      writes.push([id, name]);
      expect(id).toBe(copy!.id);
      expect(text).toBe("edited soul\r\n");
      return true;
    },
  });
  expect(copied).toBe("copied");
  expect(writes).toEqual([[copy!.id, "SOUL.md"]]);

  const raced = await duplicateContactFiles(ada.id, copy!.id, {
    read: async () => {
      removeMono(copy!.id);
      return "too late";
    },
    write: async (id) => {
      writes.push([id, "late"]);
      return true;
    },
  });
  expect(raced).toBe("skipped");
  expect(writes.some((row) => row[1] === "late")).toBe(false);
  expect(findMono(ada.id)?.sessionId).toBe("chat-ada");
});

it("adds a contact from a template or from scratch, and ignores an unknown template", () => {
  const before = listMonos().length;
  expect(newContactFromTemplate("..")).toBeUndefined();
  expect(newContactFromTemplate("no-such-template")).toBeUndefined();
  expect(listMonos()).toHaveLength(before);
  const made = newContactFromTemplate("design-review", ["/work/My Project"]);
  expect(made?.name).toBe("Design review");
  expect(made?.id).not.toBe("design-review");
  expect(made?.role).toBe("Looks at a screen and ranks what to fix.");
  const again = newContactFromTemplate("design-review");
  expect(again?.id).not.toBe(made?.id);
  const blank = newContact();
  expect(blank.sessionId).toBeUndefined();
  expect(listMonos().some((mono) => mono.id === blank.id)).toBe(true);
});

it("keeps the other window's roster change when this window read a stale copy", () => {
  const ada = seed("Ada");
  const milo = seed("Milo");
  const stale = localStorage.getItem("monocode:mono-roster")!;
  const live = JSON.parse(stale) as { id: string; muted?: boolean; pinned?: boolean; name?: string }[];
  live.find((mono) => mono.id === milo.id)!.muted = true;
  const liveText = JSON.stringify(live);
  let servedStale = false;
  const store = new Map<string, string>([["monocode:mono-roster", liveText]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (key === "monocode:mono-roster" && !servedStale) {
        servedStale = true;
        return stale;
      }
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
  expect(setContactPinned(ada.id, true)?.pinned).toBe(true);
  expect(setContactMuted(ada.id, true)?.muted).toBe(true);
  const renamed = editContactProfile(ada.id, { name: "Ada L", title: "Screens" });
  expect(renamed?.name).toBe("Ada L");
  expect(removeContact(ada.id)).toBe(true);
  const rows = JSON.parse(store.get("monocode:mono-roster")!) as { id: string; muted?: boolean; name?: string }[];
  expect(rows.some((mono) => mono.id === ada.id)).toBe(false);
  expect(rows.find((mono) => mono.id === milo.id)?.muted).toBe(true);
  expect(contactWriteResult()).toBe("saved");
});

it("reports a lost save when the roster write does not stick", () => {
  const ada = seed("Ada");
  const milo = seed("Milo");
  const stuck = localStorage.getItem("monocode:mono-roster")!;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "monocode:mono-roster" ? stuck : null),
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  });
  expect(setContactPinned(ada.id, true)).toBeUndefined();
  expect(contactWriteResult()).toBe("lost");
  expect(CONTACT_SAVE_LOST).toBe("That save didn't land. Try again.");
  expect(setContactMuted(milo.id, true)).toBeUndefined();
  expect(editContactProfile(ada.id, { name: "Nope" })).toBeUndefined();
  expect(removeContact(milo.id)).toBe(false);
  expect(contactWriteResult()).toBe("lost");
  expect(JSON.parse(stuck).find((mono: { id: string }) => mono.id === milo.id).muted).toBeUndefined();
});

it("copies the soul, the memory and the skills onto the new contact only", async () => {
  const ada = seed("Ada", { role: "Design review" });
  const writes: [string, string, string][] = [];
  const copy = await duplicateContactWithFiles(ada.id, {
    read: async (id, name) => {
      if (id !== ada.id) return null;
      if (name === "SOUL.md") return "edited soul\r\n";
      if (name === "MEMORY.md") return "edited memory\r\n";
      if (name === "skills/review.md") return "how to review\n";
      if (name === "skills/ok name.md") return "a note\n";
      return null;
    },
    write: async (id, name, text) => {
      writes.push([id, name, text]);
      return true;
    },
    listSkills: async (id) => {
      expect(id).toBe(ada.id);
      return ["review", "ok name", "../etc", "bad/name", ".hidden", "a..b", "C:\\skills\\nope", ""];
    },
  });
  expect(copy?.id).not.toBe(ada.id);
  expect(copy?.name).toBe("Ada copy");
  expect(writes.map((row) => row[1]).sort()).toEqual(["MEMORY.md", "SOUL.md", "skills/ok name.md", "skills/review.md"]);
  expect(writes.every((row) => row[0] === copy?.id)).toBe(true);
  expect(findMono(ada.id)?.role).toBe("Design review");

  const late: string[] = [];
  await duplicateContactWithFiles(ada.id, {
    read: async (_id, name) => {
      if (String(name).startsWith("skills/")) {
        for (const mono of listMonos()) if (mono.id !== ada.id) removeMono(mono.id);
      }
      return "too late";
    },
    write: async (id, name) => {
      late.push(`${id}/${name}`);
      return true;
    },
    listSkills: async () => ["review"],
  });
  expect(late.some((path) => path.includes("skills/"))).toBe(false);
  expect(findMono(ada.id)?.role).toBe("Design review");
});
