// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinderHit } from "./finder";
import { useFinderSearch, type FinderSearchIO } from "./finderSearch";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function task(id: string): FinderHit {
  return {
    id,
    kind: "task",
    title: id,
    subtitle: "",
    project: "/work/proj",
    score: 1,
  };
}

describe("useFinderSearch", () => {
  let container: HTMLDivElement;
  let root: Root;
  const pending = new Map<string, ReturnType<typeof deferred<FinderHit[]>>>();

  const io: FinderSearchIO = {
    indexed: (text) => {
      const job = deferred<FinderHit[]>();
      pending.set(text, job);
      return job.promise;
    },
    remote: () => Promise.resolve([]),
    content: () => Promise.resolve([]),
    files: () => Promise.resolve([]),
    cancelRemote: () => Promise.resolve(),
    cancelContent: () => Promise.resolve(),
    monos: () => [],
    keys: () => ["/work/proj"],
  };

  function Probe() {
    const [query, setQuery] = useState("notes");
    const search = useFinderSearch(
      { open: true, query, cwd: "/work/proj", history: [], sessions: [], recents: [] },
      io,
    );
    return (
      <div>
        <button type="button" onClick={() => setQuery("other")}>
          other
        </button>
        <button type="button" onClick={() => setQuery("held")}>
          held
        </button>
        <button type="button" onClick={() => setQuery("later")}>
          later
        </button>
        <button type="button" onClick={() => search.toggleScope()}>
          scope
        </button>
        <ul>
          {search.hits.map((hit) => (
            <li key={hit.id}>{hit.id}</li>
          ))}
        </ul>
      </div>
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    pending.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function tick(ms = 40) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("drops another query's hits when that search fails, and drops a late one", async () => {
    await act(async () => {
      root.render(createElement(Probe));
    });
    await tick();
    await act(async () => {
      pending.get("notes")?.resolve([task("task:notes")]);
    });
    expect(container.textContent).toContain("task:notes");

    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("task:notes");
    await tick();
    await act(async () => {
      pending.get("other")?.reject(new Error("timed out"));
    });
    expect(container.textContent).not.toContain("task:notes");
    const held = deferred<FinderHit[]>();
    pending.set("held", held);
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "held")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await tick();
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "later")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await tick();
    await act(async () => {
      pending.get("later")?.resolve([task("task:later")]);
    });
    expect(container.textContent).toContain("task:later");
    await act(async () => {
      pending.get("held")?.resolve([task("task:stale")]);
    });
    expect(container.textContent).toContain("task:later");
    expect(container.textContent).not.toContain("task:stale");
  });

  it("keeps this query's hits when the same search fails again", async () => {
    await act(async () => {
      root.render(createElement(Probe));
    });
    await tick();
    await act(async () => {
      pending.get("notes")?.resolve([task("task:notes")]);
    });
    expect(container.textContent).toContain("task:notes");

    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "scope")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await tick();
    await act(async () => {
      pending.get("notes")?.reject(new Error("timed out"));
    });
    expect(container.textContent).toContain("task:notes");
  });
});
