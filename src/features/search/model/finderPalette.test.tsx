// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilePicker } from "../../files/ui/FilePicker";
import type { FinderHit } from "./finder";

function row(id: string, kind: FinderHit["kind"]): FinderHit {
  return { id, kind, title: id, subtitle: "", project: "/work/proj", score: 1 };
}

describe("finder highlight", () => {
  let container: HTMLDivElement;
  let root: Root;
  const opened: string[] = [];

  function Probe() {
    const [hits, setHits] = useState<FinderHit[]>([row("task:1", "task"), row("doc:1", "doc")]);
    return (
      <div>
        <button type="button" onClick={() => setHits([row("file:1", "file"), row("task:1", "task"), row("doc:1", "doc")])}>
          insert
        </button>
        <FilePicker
          open
          cwd=""
          initialQuery="notes"
          onOpenFile={() => undefined}
          onRunAction={() => undefined}
          onClose={() => undefined}
          finder={{
            hits,
            scope: "project",
            onQuery: () => undefined,
            onToggleScope: () => undefined,
            onOpen: (hit) => opened.push(hit.id),
          }}
        />
      </div>
    );
  }

  beforeEach(() => {
    opened.length = 0;
    HTMLElement.prototype.scrollIntoView = () => undefined;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function press(key: string) {
    const input = document.querySelector("[data-file-picker] input");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  it("keeps the highlighted hit when a later row is inserted above it", async () => {
    await act(async () => {
      root.render(createElement(Probe));
    });
    await act(async () => {
      press("ArrowDown");
    });
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      press("Enter");
    });
    expect(opened).toEqual(["doc:1"]);
  });
});
