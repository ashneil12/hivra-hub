// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "../../../../plugins/hivra-mirror/src/book.ts";
import { TerminalMirrorPane } from "./TerminalMirrorPane";

function session(id: string): TerminalSession {
  return { id, title: id, folder: "/work/notes", state: "running", blocks: [], updatedAt: 1 };
}

function Harness() {
  const [current, setCurrent] = useState(session("one"));
  return (
    <div>
      <button type="button" onClick={() => setCurrent(session("two"))}>
        Switch
      </button>
      <TerminalMirrorPane
        session={current}
        tasks={[{ id: "task-1", number: 1, title: "Write" }]}
        onReply={() => undefined}
        onStop={() => undefined}
        onAllow={() => undefined}
        onDeny={() => undefined}
        onAttach={() => undefined}
        onClose={() => undefined}
      />
    </div>
  );
}

describe("a reply stays with the session it was typed for", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  it("clears the draft when the open terminal session changes", async () => {
    await act(async () => {
      root.render(createElement(Harness));
    });
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "for the first session");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input?.value).toBe("for the first session");
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("input")?.value).toBe("");
  });
});
