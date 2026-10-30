// @vitest-environment happy-dom
// r96 item 3 (Critiquito, s20 BLIND 4353 shot 02): "Search the project's files", Allow, Deny and "Waiting for approval"
// showed in the transcript's code font. A row waiting on Ash's Allow reads in the app's normal font.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let r: Root | undefined;
afterEach(() => act(() => r?.unmount()));

it("the Allow row and its buttons use the normal font, not the code font", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const blocks: Block[] = [
    { id: "u", role: "user", text: "tally tests are red again. run them and fix whatever's broken" },
    { id: "a", role: "assistant", text: "I'll find the failing one and fix it in the project." },
    {
      id: "t",
      role: "tool",
      text: "Find files",
      tool: { kind: "execute", status: "pending", command: "rg --files --hidden" },
      approval: { requestId: 7 },
    } as Block,
  ];
  await act(async () => r!.render(createElement(AgentTranscript, { blocks, busy: true, onApproval: () => undefined })));
  const controls = host.querySelector("[data-approval-controls]")!;
  expect(controls).not.toBeNull();
  expect(controls.className.split(/\s+/)).toContain("font-sans");
  expect(controls.textContent).toContain("Allow");
  const row = host.querySelector("[data-approval-row]")!;
  expect(row).not.toBeNull();
  expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(["font-sans", "[&_*]:font-sans"]));
  expect(row.textContent).toContain("Search the project's files");
});
