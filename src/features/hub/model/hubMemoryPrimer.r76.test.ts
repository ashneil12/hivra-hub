// r76 (blind s11, P8): the Lead asked Ash a question, Ash answered "private by default...", the Lead said so, and then
// the room's ash_recall found nothing: the Lead's memory note said to save only when Ash says remember or lock.
import { expect, it } from "vitest";
import { memoryPrimerBlock } from "./hubMemoryPrimer";

const primer = { name: "Tally", text: "## Tally: decisions, newest first\n- accent is teal #0F766E" } as never;

it("a Lead saves Ash's answer to its own question at once", () => {
  const lead = memoryPrimerBlock("tally", primer, { worker: false });
  expect(lead).toMatch(/Save to ~\/agent-memory\/tally\/decisions\.md at once/);
  expect(lead).toMatch(/answers a question you asked/);
  expect(lead).not.toMatch(/only when \S+ says remember or lock/);
});

it("a worker still reports instead of saving", () => {
  const worker = memoryPrimerBlock("tally", primer, { worker: true });
  expect(worker).not.toMatch(/Save to/);
});
