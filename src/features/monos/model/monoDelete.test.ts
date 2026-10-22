// @vitest-environment happy-dom
// r30f: Delete mono's confirm says only what happens. Deleting a Mono takes its current chat, its roster entry and its
// hub team, and its habits stop (the runner only walks the roster); its folder (soul, memory, habits.json, chats.json)
// is never touched, so the copy says the soul and memory stay, and where.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoked: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (cmd: string) => void invoked.push(cmd) }));

beforeEach(() => {
  invoked.length = 0;
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

const src = (path: string) => readFileSync(`${process.cwd()}/${path}`, "utf8");

it("says the chat goes, habits stop, and the soul and memory stay in the Monos' home", async () => {
  const { monoDeleteDetail } = await import("./monoDelete");
  expect(monoDeleteDetail(true)).toBe("Its current chat will be deleted and its habits stop. Its soul and memory stay in ~/agent-memory/monos/.");
  // No chat: none to delete, and no habits run (they need its chat), so only what stays is said.
  expect(monoDeleteDetail(false)).toBe("Its soul and memory stay in ~/agent-memory/monos/.");
});

it("names a dev copy's own home when it isn't the daily one", async () => {
  const { setMonoHomeRoot, monoHomeShown } = await import("../../hub/model/hubMcp");
  setMonoHomeRoot("/Users/ash/Library/Application Support/dev.monocode/monos");
  expect(monoHomeShown()).toBe("/Users/ash/Library/Application Support/dev.monocode/monos");
  setMonoHomeRoot("/Users/ash/agent-memory/monos");
  expect(monoHomeShown()).toBe("~/agent-memory/monos");
  setMonoHomeRoot(undefined);
});

it("removing a Mono never asks the app to delete, move or archive its folder", async () => {
  const { createMono, removeMono, listMonos } = await import("./mono");
  const mono = createMono();
  invoked.length = 0;
  removeMono(mono.id);
  await new Promise((r) => setTimeout(r, 0));
  expect(listMonos().some((m) => m.id === mono.id)).toBe(false);
  expect(invoked.filter((cmd) => /archive|delete|remove|trash/i.test(cmd))).toEqual([]);
});

it("the App's Delete mono does what the copy says, and no more", () => {
  const app = src("src/app/App.tsx");
  const body = app.slice(app.indexOf("const onDeleteMono = useCallback("), app.indexOf("const onDeleteMonoChat = useCallback("));
  expect(body).toMatch(/confirmDelete\(name, monoDeleteDetail\(!!mono\.sessionId\)\)/);
  expect(body).toMatch(/onRemoveHistorySession\(\s*mono\.sessionId,\s*"delete"/);
  expect(body).toMatch(/removeMono\(monoId\)/);
  expect(body).toMatch(/forgetMonoTeam\(monoId\)/);
  // Not its folder: no retire/archive, no file commands.
  expect(body).not.toMatch(/retireMono|mono_archive|invoke\(/);
  // Habits stop because the runner only walks the roster.
  expect(src("src/app/hooks/useMonoHabits.ts")).toMatch(/for \(const \{ id, sessionId \} of listMonos\(\)\)/);
});

it("light theme: Cancel's ring is mixed toward the text colour (the plain accent was 2.69:1)", () => {
  expect(src("src/shared/ui/ConfirmDelete.tsx")).toMatch(/"confirm-cancel-ring /);
  expect(src("src/styles/index.css")).toMatch(/html\.theme-light \.confirm-cancel-ring:focus \{\s*--tw-ring-color: color-mix\(in srgb, var\(--color-accent\) 65%, var\(--color-content\)\);/);
});
