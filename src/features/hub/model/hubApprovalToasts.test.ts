// @vitest-environment happy-dom
// r82 (Critiquito's r81 blocker): the pop-up covered the Inbox summary with an amber "Question", "Delete keep" and
// "Claude Code". An ask already listed gets none; any other is a neutral card with a red Needs you, the real question
// and who asks, in the sidebar's empty foot.
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalToasts } from "../../sessions/ui/ApprovalToasts";
import { hubToastNotices, hubToastView } from "./hubApprovalToasts";

type Notice = ComponentProps<typeof ApprovalToasts>["notices"][number];
const session = (id: string, over: Partial<Notice["session"]> = {}) =>
  ({ id, cwd: `/projects/${id}`, title: "Add tally delete", harness: "claude", model: "", modelSettings: {}, runtimeMode: "supervised", blocks: [], ...over }) as Notice["session"];

const question = (id: string): Notice => ({
  sessionId: id,
  requestId: 3,
  label: "Delete keep",
  kind: "question",
  session: session(id, {
    pendingQuestion: {
      requestId: 3,
      title: "Delete keep",
      questions: [{ id: "q", header: "Delete keep", prompt: "When someone deletes a tally, should it be gone for good or kept 30 days?", multiSelect: false, allowCustom: true, options: [{ id: "a", label: "Gone for good" }, { id: "b", label: "Keep 30 days" }] }],
    },
  }),
});

const read = (id: string): Notice => {
  const block = { id: "b1", role: "assistant", text: "", tool: { title: "Read" }, approval: { requestId: 9, decided: false, call: { tool: "Read", paths: ["/p/tally-worktrees/mc-1/packages/ui/src/App.tsx"] } } } as unknown as NonNullable<Notice["block"]>;
  return { sessionId: id, requestId: 9, label: "Read App.tsx", kind: "approval", block, session: session(id, { title: "Tally API and board updates", blocks: [block] }) };
};

it("an ask already listed on screen gets no pop-up", () => {
  const notices = [question("listed"), question("other")];
  expect(hubToastNotices(notices, (id) => id === "listed").map((n) => n.sessionId)).toEqual(["other"]);
});

it("reads the real question and names the Lead or the job, never Claude Code", () => {
  expect(hubToastView(question("w"), undefined)).toEqual({
    badge: "Needs you",
    question: "When someone deletes a tally, should it be gone for good or kept 30 days?",
    by: "Add tally delete",
  });
  const permission = hubToastView(read("l"), "Tally lead");
  expect(permission.question).toBe("Allow the Tally lead to look at App.tsx?");
  expect(permission.by).toBe("Tally lead");
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("the card is neutral, with a red Needs you, in the sidebar's foot, not over the page", async () => {
  await act(async () =>
    root.render(createElement(ApprovalToasts, { notices: [question("w")], onApproval: vi.fn(), onFocusSession: vi.fn(), hubView: (n) => hubToastView(n, undefined) })),
  );
  const card = document.querySelector(".approval-toast")!;
  const text = card.textContent ?? "";
  expect(text).toContain("Needs you");
  expect(text).toContain("should it be gone for good or kept 30 days?");
  expect(text).not.toContain("Delete keep");
  expect(text).not.toContain("Claude Code");
  expect(text).not.toContain("Question");
  expect(card.innerHTML).not.toMatch(/amber/);
  expect(card.querySelector("[data-hub-chip='Needs you']")?.className).toMatch(/text-red-400/);
  const stack = card.parentElement as HTMLElement;
  expect(stack.style.bottom).toBe("40px");
  expect(stack.style.top).toBe("");
  expect(stack.className).not.toMatch(/right-3/);
});
