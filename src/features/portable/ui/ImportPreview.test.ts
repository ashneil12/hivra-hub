// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it } from "vitest";
import type { SetupDoc } from "../model/setupDoc";
import { ImportPreview } from "./ImportPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => localStorage.clear());

const doc = (settings: Record<string, string>): SetupDoc => ({
  format: "monocode-hub-setup",
  version: 2,
  exportedAt: "",
  projects: [],
  projectPrefs: { names: {}, order: [], hidden: [], icons: {} },
  monos: [],
  teams: [],
  connectors: [],
  pages: [],
  customModels: [],
  settings,
});

it("the preview names each setting an import would add or change, not just how many", async () => {
  localStorage.setItem("monocode.themeScheme", "daylight");
  const pending = { name: "x", path: null, doc: doc({ "monocode.themeScheme": "midnight", "monocode.accentColor": "hsl(1 2% 3%)" }), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(createElement(ImportPreview, { pending, inline: true, onBack: () => undefined, onRestore: async () => ({ lines: [], rust: null, problems: [] }) })),
  );
  const section = host.querySelector("[data-portable-section=settings]")!.textContent!;
  expect(section).toContain("accentColor");
  expect(section).toContain("themeScheme");
});

it("the preview says which files are too big and will be left out, before the restore", async () => {
  const inspection = {
    format: "v2" as const,
    v1: null,
    manifest: null,
    files: {},
    memory: [],
    workspace: null,
    memoryTarget: "",
    leftOut: [
      { path: "workspace/sessions/huge.json", reason: "is 600 MB, more than a file of that kind may be (512 MB)" },
      { path: "setup/big.json", reason: "would take the setup files past the 256 MB the preview holds" },
    ],
  };
  const pending = { name: "x", path: "/x", doc: doc({}), inspection, fromV1: false, folders: {}, skillsHere: {} };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(createElement(ImportPreview, { pending, inline: true, onBack: () => undefined, onRestore: async () => ({ lines: [], rust: null, problems: [] }) })),
  );
  const section = host.querySelector("[data-portable-section=left-out]")!.textContent!;
  expect(section).toContain("2 files were too big and will be left out");
  expect(section).toContain("workspace/sessions/huge.json");
  expect(section).toContain("setup/big.json");
  expect(section).not.toMatch(/stuck/i);
});

const project = (id: string, folder: string) => ({ id, name: id.toUpperCase(), shortName: id, iconShape: "folder", folder, template: "product-saas" as const });

async function showFolders(onRestore: (plan: unknown, choices: { projectFolders: Set<string> }) => Promise<never>) {
  const pending = {
    name: "x",
    path: null,
    doc: { ...doc({}), projects: [project("zz-a", "/Users/x/code/a"), project("zz-b", "/Users/x/code/b"), project("zz-c", "/Users/x"), project("zz-d", "/elsewhere/d")] },
    inspection: null,
    fromV1: false,
    folders: { "/Users/x/code/a": true, "/Users/x/code/b": true, "/Users/x": true, "/elsewhere/d": false },
    // The home folder is on this Mac, and Rust refuses it.
    folderChecks: { "/Users/x": "it is your home folder, or a folder that holds it, so it can't be a project's folder" },
    skillsHere: {},
  };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(createElement(ImportPreview, { pending, inline: true, onBack: () => undefined, onRestore: onRestore as never })),
  );
  return host;
}

const ticked = (host: HTMLElement, id: string) => host.querySelector(`[data-portable-row=project-folder-${id}] [role=checkbox], [data-portable-row=project-folder-${id}] input`);

it("lists every project folder the file wants to register, each unticked, and says why one can't be", async () => {
  const host = await showFolders(async () => ({ lines: [], rust: null, problems: [] }) as never);
  const section = host.querySelector("[data-portable-section=project-folders]")!;
  for (const folder of ["/Users/x/code/a", "/Users/x/code/b", "/Users/x", "/elsewhere/d"]) expect(section.textContent).toContain(folder);
  expect(section.textContent).toContain("Nothing is ticked for you");
  expect(section.textContent).toContain("can't be adopted, because it is your home folder");
  expect(section.textContent).toContain("isn't on this Mac");
  for (const id of ["zz-a", "zz-b", "zz-c", "zz-d"]) {
    const box = ticked(host, id) as HTMLElement | null;
    expect(box, id).not.toBeNull();
    expect(box!.getAttribute("aria-checked") ?? (box as HTMLInputElement).checked?.toString(), id).toMatch(/false/);
  }
});

it("Tick all ticks the folders that can be adopted and never the refused or missing ones; Restore sends only those", async () => {
  let sent: Set<string> | null = null;
  const host = await showFolders(async (_plan, choices) => {
    sent = choices.projectFolders;
    return { lines: [], rust: null, problems: [] } as never;
  });
  await act(async () => {
    (host.querySelector("[data-project-folders-all]") as HTMLButtonElement).click();
  });
  const text = host.querySelector("[data-project-folders-all]")!.textContent;
  expect(text).toBe("Untick all");
  const restore = [...host.querySelectorAll("button")].find((b) => /^Restore/.test(b.textContent ?? ""))!;
  await act(async () => {
    restore.click();
  });
  expect([...(sent as unknown as Set<string>)].sort()).toEqual(["zz-a", "zz-b"]);
});
