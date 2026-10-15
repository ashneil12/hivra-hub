// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { RestorePreview } from "./RestorePreview";
import type { SetupFile } from "../model/setupFile";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("the Restore preview lists the Pages it will restore, and says which will ask again", async () => {
  const file: SetupFile = {
    format: "monocode-hub-setup", version: 1,
    projects: [{ id: "moonrise", name: "Moonrise", shortName: "Moonrise", iconShape: "sparkles", folder: "/x", template: "game-studio" } as never],
    pages: [
      { id: "p1", projectId: "moonrise", title: "Example: harvest board", request: "r", by: "PM", permissions: [], spec: { kind: "blocks", title: "Example: harvest board", blocks: [] } } as never,
      { id: "p2", projectId: "moonrise", title: "Example: growth room", request: "r", by: "PM", permissions: [], spec: { kind: "bespoke", title: "Example: growth room", html: "", css: "", js: "", permissions: ["keys.read:Anthropic"] } } as never,
    ],
  };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => createRoot(host).render(createElement(RestorePreview, { file, name: "s.json", inline: true })));
  const text = host.querySelector("[data-restore-pages]")!.textContent!;
  expect(text).toContain("Example: harvest board");
  expect(text).toContain("Example: growth room");
  expect(text).toContain("asks again before it can do anything");
});
