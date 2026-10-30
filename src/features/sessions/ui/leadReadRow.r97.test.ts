// @vitest-environment happy-dom
// r97 item 2 (c02 BLIND 242d): the Lead's reads of its workers' files showed the whole temp path. The row shows the
// path inside the checkout (or the last two parts), and the full path stays in the hover text.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { shortToolTarget } from "../model/transcriptActivity";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let r: Root | undefined;
afterEach(() => act(() => r?.unmount()));

const ROOT = "/private/var/folders/b4/8qh0t36j0_g9srqzx1g5t3z40000gn/T/monocode-realtest-oWwZm6/projects";
const FULL = `${ROOT}/tally-worktrees/mc-857b7910/packages/api/src/server.ts`;

it("shortens 242d's paths and leaves short ones alone", () => {
  expect(shortToolTarget(`${ROOT}/tally-worktrees/mc-098cbf4c/README.md`)).toBe("README.md");
  expect(shortToolTarget(FULL)).toBe("packages/api/src/server.ts");
  expect(shortToolTarget("/Users/ash/notes/deep/today.md")).toBe("…/deep/today.md");
  expect(shortToolTarget("packages/api/src/server.ts")).toBe("packages/api/src/server.ts");
  expect(shortToolTarget("README.md")).toBe("README.md");
});

it("the Lead's read row shows the short path, the full one on hover", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  const blocks: Block[] = [
    { id: "u", role: "user", text: "hows it going" },
    { id: "t", role: "tool", text: `Read ${FULL}`, tool: { kind: "read", status: "in_progress", title: `Read ${FULL}`, preview: { kind: "read", path: FULL } } } as Block,
  ];
  await act(async () => r!.render(createElement(AgentTranscript, { blocks, busy: true, cwd: `${ROOT}/tally` } as never)));
  expect(host.textContent).toContain("packages/api/src/server.ts");
  expect(host.textContent).not.toContain("/private/var/folders");
  expect(host.querySelector(`[title="${FULL}"]`)).not.toBeNull();
});
