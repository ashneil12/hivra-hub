// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { listMonos } from "../../monos/model/mono";
import { restoreMonoRoster } from "./restore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("team folder unavailable");
  }),
}));

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
}

it("puts a Mono back from its payload, and ignores one that is not a Mono", async () => {
  storage();
  await restoreMonoRoster("m1", JSON.stringify({ id: "m1", name: "Pip", mascot: "cat", color: "red", projects: [] }));
  expect(listMonos().some((mono) => mono.id === "m1" && mono.name === "Pip")).toBe(true);

  await expect(restoreMonoRoster("nope", "not json")).resolves.toBeUndefined();
  expect(listMonos().some((mono) => mono.id === "nope")).toBe(false);
});
