// @vitest-environment happy-dom
// r61 (PM's blind C3 on 0.16.2): the PM Mono told Ash its preview was "on Today", and there is no Today page. What
// page_build hands back names the place as the Pages screen shows it.
import { beforeEach, expect, it } from "vitest";
import { resetPagesForTest } from "../../pages/model/pages";
import { keepFromChat, NO_PROJECT, previewFromChat } from "./pagesChat";

beforeEach(() => {
  localStorage.clear();
  resetPagesForTest();
});

const spec = { kind: "blocks", title: "Agents now", blocks: [{ kind: "note", title: "About", text: "What each agent does." }] };

it("a page with no project is 'not tied to a project' on Pages, never Today, in the preview and once kept", async () => {
  const out = previewFromChat({ spec, request: "a page of agents" }, { monoId: "pm", name: "Projects Manager" });
  expect(out.project).toBe(NO_PROJECT);
  expect(out.where).toBe("A preview on Hubs (not tied to a project)");
  expect(JSON.stringify(out)).not.toMatch(/on Today/);
  const kept = await keepFromChat(out.previewId, { monoId: "pm" }, () => true);
  expect(kept.note).toMatch(/^It's on Hubs \(not tied to a project\)/);
});
