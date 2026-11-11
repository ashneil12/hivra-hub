// @vitest-environment happy-dom
// WP-04 review: Settings can run the Ash OS import again after any earlier answer, and says how it went.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { appHubTransport, resetAppHubTransportForTest } from "../model/localHub/localTransport";
import { IMPORT_KEY, type ImportFound } from "../model/localHub/ashOsImport";
import { AshOsImportButton } from "./AshOsImportButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => resetAppHubTransportForTest());

it("runs the import again after Start clean and shows what came over", async () => {
  const hub = appHubTransport().hub;
  await hub.disk.write(IMPORT_KEY, { decided: "declined", at: "2026-11-03T00:00:00Z" });
  const found: ImportFound = { state: "found", projects: [{ id: "exo", name: "EXO game" }], memberships: [], pages: [] };
  const asked: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(createElement(AshOsImportButton, { deps: { fetch: async () => found, ask: async (q) => (asked.push(q), "import") } }));
    await new Promise((r) => setTimeout(r, 10));
  });
  await act(async () => {
    host.querySelector<HTMLButtonElement>("[data-ash-os-import-run]")!.click();
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(asked).toHaveLength(1);
  expect(host.querySelector("[data-ash-os-import-outcome]")?.textContent).toBe("Brought over 1 project, 0 Monos' projects and 0 kept Hubs.");
  expect((await hub.projects()).projects.map((p) => p.id)).toEqual(["exo"]);
  expect(await hub.disk.read(IMPORT_KEY)).toMatchObject({ decided: "imported" });
});

it("is hidden when there's no Ash OS here", async () => {
  await appHubTransport().hub.disk.write(IMPORT_KEY, { decided: "none", at: "2026-11-03T00:00:00Z", message: "Ash OS isn't set up on this Mac." });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(createElement(AshOsImportButton));
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(host.querySelector("[data-ash-os-import]")).toBeNull();
});
