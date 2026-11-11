import { expect, it } from "vitest";
import type { NeedsItem } from "../../features/needs/model/needsYou";
import { monoPanelAsks } from "./monoPanelAsks";

function item(key: string, kind: NeedsItem["kind"], monoId: string, sentence: string): NeedsItem {
  return { key, kind, monoId, who: "Lead", at: 1, sentence, actions: [{ label: "Open", run: () => undefined }] };
}

it("lists the questions and approvals a mono's red number counts, and not its stopped row", () => {
  const items = [
    item("stopped:1", "stopped", "lead", "Out of credits"),
    item("question:1", "question", "lead", "Which font?"),
    item("approval:1", "approval", "other", "Run the deploy?"),
  ];
  const red = items.filter((row) => row.monoId === "lead").length;
  const asks = monoPanelAsks(items, "lead");
  expect(asks.map((ask) => ask.id)).toEqual(["question:1"]);
  expect(1 + asks.length).toBe(red);
});
