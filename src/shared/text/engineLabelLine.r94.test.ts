// @vitest-environment happy-dom
// r94 (Critiquito d, s15 SCRIPTED 3cde): the Lead put the label on the next line with ONE newline, which markdown reads
// as a soft break, so "That's running now. Grok 4.7 · High · DeepSeek wasn't available" rendered on one line again.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { engineLabelOnOwnLine } from "./engineLabelLine";

const reply =
  'Showing the tally count at the top of the board, from your note: "can the board show how many tallies there are at the top?"\n\nThat\'s running now.\nGrok 4.7 · High · DeepSeek wasn\'t available';

it("a label on the next line after a single newline becomes its own paragraph", () => {
  expect(engineLabelOnOwnLine(reply)).toBe(reply.replace("now.\nGrok", "now.\n\nGrok"));
  // Two labels in a row, or a label already apart, are left as they are.
  expect(engineLabelOnOwnLine("ok.\n\nGrok 4.7 · High")).toBe("ok.\n\nGrok 4.7 · High");
  // A list item that happens to hold a dot is not a label.
  expect(engineLabelOnOwnLine("Totals:\n3 · 4 tallies")).toBe("Totals:\n3 · 4 tallies");
});

it("rendered, the label is a paragraph of its own, never inline after the sentence", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { AgentMarkdown } = await import("../../features/sessions/ui/AgentMarkdown");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(AgentMarkdown, { text: engineLabelOnOwnLine(reply), streaming: false })));
  const paragraphs = [...host.querySelectorAll("p")].map((p) => p.textContent?.trim());
  expect(paragraphs).toContain("That's running now.");
  expect(paragraphs).toContain("Grok 4.7 · High · DeepSeek wasn't available");
  await act(async () => root.unmount());
});
