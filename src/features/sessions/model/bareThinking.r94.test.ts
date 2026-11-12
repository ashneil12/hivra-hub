// @vitest-environment happy-dom
// r94 (Critiquito f): no bare "Thinking" row under a reply, in any list that shows a chat's steps.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { isBareThought } from "./transcriptActivity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reply: Block = { id: "r", role: "assistant", text: "Fixed the median; npm test is green (4 of 4)." };
const thought = (id: string, text: string, streaming = false): Block => ({ id, role: "reasoning", text, streaming });

describe("isBareThought", () => {
  it("is a thought that would only say Thinking", () => {
    expect(isBareThought(thought("t", "Weighing it."), true)).toBe(true);
    expect(isBareThought(thought("t", "Weighing it.", true), false)).toBe(true);
    expect(isBareThought(thought("t", "  "), false)).toBe(true);
    expect(isBareThought(thought("t", "Weighing it."), false)).toBe(false);
    expect(isBareThought(reply, true)).toBe(false);
  });
});

it("a Mono's activity list shows the reply and no bare Thinking row under it", async () => {
  const { MonoActivityTrail } = await import("../ui/AgentTranscript");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(MonoActivityTrail, { blocks: [reply, thought("t1", "Should I also check the board?", true)], live: true } as never)),
  );
  expect(host.textContent).toContain("npm test is green");
  expect(host.textContent).not.toMatch(/Thinking/);
  await act(async () => root.unmount());
});

it("(g) a rendered Mono reply says Nothing needs you once", async () => {
  const { MonoActivityTrail } = await import("../ui/AgentTranscript");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const said: Block = { id: "s", role: "assistant", text: "Nothing needs you. No questions are waiting." };
  await act(async () => root.render(createElement(MonoActivityTrail, { blocks: [said] } as never)));
  expect(host.textContent).toContain("Nothing needs you.");
  expect(host.textContent).not.toMatch(/No questions/);
  await act(async () => root.unmount());
});
