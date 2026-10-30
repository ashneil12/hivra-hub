// @vitest-environment happy-dom
// r96 item 3 (Critiquito, c02 BLIND 6968): the chat showed raw commands as step rows. They read in plain words, with
// the command itself kept in the row's tooltip.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let r: Root | undefined;
afterEach(() => act(() => r?.unmount()));

it("a run of the tests reads 'Run the tests', with the command behind it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const cmd = "rg -n --heading 'BoardTally|title: string' packages/ui; npm test";
  const blocks: Block[] = [
    { id: "u", role: "user", text: "board tally is off by one, fix it" },
    { id: "t", role: "tool", text: cmd, tool: { kind: "execute", status: "completed", command: cmd } } as Block,
  ];
  await act(async () => r!.render(createElement(AgentTranscript, { blocks, busy: true })));
  const row = host.querySelector("[data-plain-command]");
  expect(row?.textContent).toBe("Search the code, then run the tests");
  expect(row?.getAttribute("title")).toBe(cmd);
  expect(host.textContent).not.toContain("rg -n --heading");
});
