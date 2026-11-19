// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blankProposal } from "../model/record";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("reads the stored revision, so another window's save does not block this one", async () => {
  const host = await import("../model/host");
  const chats = await import("../../hub/model/hubChats");
  const { CouncilRoom } = await import("./CouncilRoom");
  host.setCouncilEnginesForTests([{ cli: "claude", family: "Anthropic", label: "Claude Code" }]);
  host.setCouncilModel(async () => ({ text: "ok" }));
  const room = chats.createChat("hub", "Council", []);
  expect(chats.saveCouncil(room.id, blankProposal("Should we ship?"), 0)).toBe(true);

  const show = () => act(() => root.render(createElement(CouncilRoom, { chatId: room.id, onClose: () => {} })));
  show();

  const current = chats.getChat(room.id)!.council!;
  expect(chats.saveCouncil(room.id, { ...current, question: "from the other window" }, current.revision)).toBe(true);
  expect(chats.getChat(room.id)!.council!.revision).toBe(2);
  show();

  act(() => {
    container.querySelector<HTMLButtonElement>("[data-council-confirm]")!.click();
  });
  const saved = chats.getChat(room.id)!.council!;
  // Dropwave: in a team's chat the council is a mode, so a sent question is asked at once (no "confirm the question").
  expect(saved.phase).toBe("running");
  expect(saved.revision).toBe(3);
  expect(saved.question).toBe("from the other window");
  host.setCouncilEnginesForTests(undefined);
  host.setCouncilModel(undefined);
});
