// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RestorePreview } from "./RestorePreview";
import { readImportText } from "../../portable/model/portable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function show(file: unknown, onRestore = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const pending = readImportText("s.json", JSON.stringify(file));
  await act(async () => createRoot(host).render(createElement(RestorePreview, { pending, inline: true, onRestore })));
  return host;
}

it("the Restore preview lists the Pages it will restore, and says which will ask again", async () => {
  const host = await show({
    format: "monocode-hub-setup", version: 1,
    projects: [{ id: "moonrise", name: "Moonrise", shortName: "Moonrise", iconShape: "sparkles", folder: "/x", template: "game-studio" }],
    pages: [
      { id: "p1", projectId: "moonrise", title: "Example: harvest board", request: "r", by: "PM", permissions: [], spec: { kind: "blocks", title: "Example: harvest board", blocks: [] } },
      { id: "p2", projectId: "moonrise", title: "Example: growth room", request: "r", by: "PM", permissions: [], spec: { kind: "bespoke", title: "Example: growth room", html: "", css: "", js: "", permissions: ["keys.read:Anthropic"] } },
    ],
  });
  const text = host.querySelector("[data-portable-section=pages]")!.textContent!;
  expect(text).toContain("Example: harvest board");
  expect(text).toContain("Example: growth room");
  expect(text).toContain("asks again before it can do anything");
  expect(host.textContent).toContain("An older setup file");
});

it("no Projects heading when the file has no projects", async () => {
  const host = await show({ format: "monocode-hub-setup", version: 1, projects: [], pages: [] });
  expect(host.querySelector("[data-portable-section=projects]")).toBeNull();
});

it("Restore hands over what is ticked and then says what was added", async () => {
  const onRestore = vi.fn(async () => ({ lines: ["1 Mono waiting for your OK in the Monos list."], rust: null, problems: [] }));
  const host = await show({
    format: "monocode-hub-setup", version: 1, projects: [],
    souls: [{ monoId: "ledger", name: "Ledger", role: "Keeps the books", rules: "# r", memory: "", workflows: "", skills: [] }],
  }, onRestore);
  expect(host.querySelector("[data-portable-row=mono-ledger]")!.textContent).toContain("Waits for your OK");
  await act(async () => (host.querySelector("[data-portable-restore]") as HTMLButtonElement).click());
  expect(onRestore).toHaveBeenCalledTimes(1);
  const [, , choices] = onRestore.mock.calls[0] as unknown as [unknown, unknown, { monos: Set<string> }];
  expect([...choices.monos]).toEqual(["ledger"]);
  expect(host.querySelector("[data-portable-restored]")!.textContent).toContain("1 Mono waiting for your OK");
});
