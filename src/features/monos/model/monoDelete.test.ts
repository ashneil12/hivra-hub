// @vitest-environment happy-dom
// r30f: Delete mono's confirm says only what happens. Deleting a Mono takes its current chat, its roster entry and its
// hub team, and its habits stop (the runner only walks the roster). WP-76: its files go to the trash for 30 days
// and can be put back. The copy does not name a folder path.
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

it("says the chat stops, habits stop, and the files can be put back, with no folder path", async () => {
  const { monoDeleteDetail } = await import("./monoDelete");
  expect(monoDeleteDetail(true)).toBe(
    "Its current chat is stopped and moved to the trash with it, and its habits stop. Its files go to the trash for 30 days, and you can put them back.",
  );
  expect(monoDeleteDetail(false)).toBe("Its files go to the trash for 30 days, and you can put them back.");
  expect(monoDeleteDetail.length).toBe(1);
  expect(monoDeleteDetail(true)).not.toMatch(/\/|\\/);
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
  expect(body).toMatch(/confirmDelete\(name, monoDeleteDetail\(!!mono\.sessionId\), \{ undoable: true \}\)/);
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

it("light theme: the red Delete label is red-700 on a light tint (red-400 was 2.02:1); dark stays red-400 on red-500/20", () => {
  const confirm = src("src/shared/ui/ConfirmDelete.tsx");
  const danger = /export const DELETE_DANGER =\s*"([^"]+)"/.exec(confirm)?.[1].split(" ") ?? [];
  expect(danger).toEqual(expect.arrayContaining(["bg-red-500/10", "text-red-700", "dark:bg-red-500/20", "dark:text-red-400", "dark:hover:bg-red-500/30"]));
  // No unprefixed red-400 left to paint the light theme.
  expect(danger).not.toContain("text-red-400");
  expect(confirm).toMatch(/data-confirm-delete-ok[\s\S]*?\$\{DELETE_DANGER\}/);
  // `dark:` is "not the light theme".
  expect(src("src/styles/index.css")).toContain("@custom-variant dark (&:where(html:not(.theme-light), html:not(.theme-light) *));");
});
