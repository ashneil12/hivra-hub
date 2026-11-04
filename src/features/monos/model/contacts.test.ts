// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { findMono, listMonos, removeMono, updateMono } from "./mono";
import {
  contactRows,
  duplicateContact,
  duplicateContactFiles,
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
