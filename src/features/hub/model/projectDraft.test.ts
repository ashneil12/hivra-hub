// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { clearProjectDraft, projectDraft, saveProjectDraft } from "./projectDraft";
import { NewProjectView } from "../ui/NewProjectView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => clearProjectDraft());

it("a draft with a name is kept (and stored); an unnamed one isn't shown", () => {
  saveProjectDraft({ name: "", started: false, lines: [], answers: [], tpl: null, addon: false });
  expect(projectDraft()).toBeNull();
  saveProjectDraft({ name: "Moonrise", started: true, lines: [{ from: "cos", text: "Q1" }], answers: [], tpl: null, addon: false });
  expect(projectDraft()?.name).toBe("Moonrise");
  expect(JSON.parse(localStorage.getItem("monocode:hub-project-draft")!).name).toBe("Moonrise");
  clearProjectDraft();
  expect(projectDraft()).toBeNull();
});

it("leaving mid-interview and coming back shows the chat as it was", async () => {
  saveProjectDraft({
    name: "Moonrise", started: true, answers: ["A cosy farming game"], tpl: null, addon: false,
    lines: [{ from: "cos", text: "Let's set up Moonrise. What is it, in a sentence?" }, { from: "ash", text: "A cosy farming game" }, { from: "cos", text: "Who is it for?" }],
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(NewProjectView)));
  expect(host.textContent).toContain("New project: Moonrise");
  expect(host.textContent).toContain("A cosy farming game");
  expect(host.textContent).toContain("Who is it for?");
  await act(async () => root.unmount());
  expect(projectDraft()?.answers).toEqual(["A cosy farming game"]);
});
