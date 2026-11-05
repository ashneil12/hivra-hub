// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocRecord, DocsGateway, DocWriteResult } from "../gateway";
import { DocsScreen } from "./DocsScreen";

function paragraph(text: string): string {
  return JSON.stringify([
    { id: "b1", type: "paragraph", props: {}, children: [], content: [{ type: "text", text, styles: {} }] },
  ]);
}

function page(id: string, title: string, body: string, version: number): DocRecord {
  return {
    id,
    slug: id,
    title,
    body,
    blocksJson: paragraph(body),
    parentId: null,
    sortOrder: 0,
    version,
    tags: [],
    sourceCwd: null,
    sourceSessionId: null,
    favourite: false,
    lastOpenedAt: null,
    trashedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function button(title: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === title);
  if (!found) throw new Error(`No button ${title}`);
  return found as HTMLButtonElement;
}

function area(): HTMLTextAreaElement {
  const found = container.querySelector("textarea");
  if (!found) throw new Error("No block");
  return found as HTMLTextAreaElement;
}

function typeBlock(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(area(), value);
    area().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("DocsScreen saves", () => {
  it("does not write the previous page onto the one that is still opening", async () => {
    const pages = new Map<string, DocRecord>([
      ["a", page("a", "Alpha", "Alpha", 0)],
      ["b", page("b", "Bravo", "Bravo", 0)],
    ]);
    let release: (() => void) | null = null;
    const updates: string[] = [];
    const gateway: DocsGateway = {
      list: async () => [...pages.values()],
      get: (id) => {
        if (id === "b") {
          return new Promise((resolve) => {
            release = () => resolve({ ...pages.get(id)! });
          });
        }
        return Promise.resolve({ ...pages.get(id)! });
      },
      create: async () => ({ status: "conflict", version: 0 }),
      update: async (input) => {
        updates.push(input.body);
        const current = pages.get(input.id)!;
        current.body = input.body;
        current.blocksJson = input.blocksJson ?? current.blocksJson;
        current.version += 1;
        return { status: "saved", page: { ...current }, newMentions: [] };
      },
      adopt: async () => ({ status: "conflict", version: 0 }),
      move: async () => ({ status: "conflict", version: 0 }),
      versions: async () => [],
      restore: async () => ({ status: "conflict", version: 0 }),
      favourite: async (id) => ({ ...pages.get(id)! }),
      touch: async (id) => ({ ...pages.get(id)! }),
      trash: async () => undefined,
      resolve: async () => ({ kind: "page", targetId: "a", name: "Alpha", found: false }),
      export: async () => [],
    };
    await act(async () => {
      root.render(createElement(DocsScreen, { onClose: () => {}, gateway, idleMs: 50 }));
    });
    await flush();
    await act(async () => {
      button("Alpha").click();
    });
    await flush();
    expect(area().value).toBe("Alpha");
    await act(async () => {
      button("Bravo").click();
    });
    typeBlock("Stolen");
    release?.();
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(pages.get("b")?.body).toBe("Bravo");
    expect(updates).toEqual([]);
  });

  it("does not save the local draft again when the page changed somewhere else", async () => {
    const stored = page("a", "Alpha", "Server", 1);
    let calls = 0;
    const gateway: DocsGateway = {
      list: async () => [{ ...stored }],
      get: async () => ({ ...stored }),
      create: async () => ({ status: "conflict", version: stored.version }),
      update: async (input) => {
        calls += 1;
        if (calls === 1) return { status: "conflict", version: 4 };
        stored.body = input.body;
        stored.blocksJson = input.blocksJson ?? stored.blocksJson;
        stored.version = input.expectedVersion + 1;
        return { status: "saved", page: { ...stored }, newMentions: [] };
      },
      adopt: async () => ({ status: "saved", page: { ...stored }, newMentions: [] }),
      move: async () => ({ status: "conflict", version: stored.version }),
      versions: async () => [],
      restore: async () => ({ status: "conflict", version: stored.version }),
      favourite: async () => ({ ...stored }),
      touch: async () => ({ ...stored }),
      trash: async () => undefined,
      resolve: async () => ({ kind: "page", targetId: "a", name: "Alpha", found: true }),
      export: async () => [],
    };
    await act(async () => {
      root.render(createElement(DocsScreen, { onClose: () => {}, gateway, idleMs: 50 }));
    });
    await flush();
    await act(async () => {
      button("Alpha").click();
    });
    await flush();
    typeBlock("Local");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(calls).toBe(1);
    expect(stored.body).toBe("Server");
    expect(container.textContent).toContain("The page changed somewhere else");
  });

  it("tries a failed save again, and a slow success keeps the version it stored", async () => {
    const stored = page("a", "Alpha", "Hello", 1);
    const versions: number[] = [];
    let failOnce = true;
    const gateway: DocsGateway = {
      list: async () => [{ ...stored }],
      get: async () => ({ ...stored }),
      create: async () => ({ status: "conflict", version: stored.version }),
      update: async (input): Promise<DocWriteResult> => {
        versions.push(input.expectedVersion);
        if (failOnce) {
          failOnce = false;
          throw new Error("offline");
        }
        stored.body = input.body;
        stored.blocksJson = input.blocksJson ?? stored.blocksJson;
        stored.version = input.expectedVersion + 1;
        return { status: "saved", page: { ...stored }, newMentions: [] };
      },
      adopt: async () => ({ status: "saved", page: { ...stored }, newMentions: [] }),
      move: async () => ({ status: "conflict", version: stored.version }),
      versions: async () => [],
      restore: async () => ({ status: "conflict", version: stored.version }),
      favourite: async () => ({ ...stored }),
      touch: async () => ({ ...stored }),
      trash: async () => undefined,
      resolve: async () => ({ kind: "page", targetId: "a", name: "Alpha", found: true }),
      export: async () => [],
    };
    await act(async () => {
      root.render(createElement(DocsScreen, { onClose: () => {}, gateway, idleMs: 50 }));
    });
    await flush();
    await act(async () => {
      button("Alpha").click();
    });
    await flush();
    typeBlock("Hello again");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(versions).toEqual([1]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(versions).toEqual([1, 1]);
    expect(stored.body).toContain("Hello again");
  });

  it("keeps the version a slow save stored, instead of writing again at the old one", async () => {
    const slow = page("b", "Bravo", "Slow", 3);
    let release: (value: DocWriteResult) => void = () => {};
    const seen: number[] = [];
    const slowGateway: DocsGateway = {
      list: async () => [{ ...slow }],
      get: async () => ({ ...slow }),
      create: async () => ({ status: "conflict", version: slow.version }),
      adopt: async () => ({ status: "saved", page: { ...slow }, newMentions: [] }),
      move: async () => ({ status: "conflict", version: slow.version }),
      versions: async () => [],
      restore: async () => ({ status: "conflict", version: slow.version }),
      trash: async () => undefined,
      resolve: async () => ({ kind: "page", targetId: "b", name: "Bravo", found: true }),
      export: async () => [],
      update: (input) => {
        seen.push(input.expectedVersion);
        if (seen.length === 1) {
          return new Promise((resolve) => {
            release = () => {
              slow.version = 8;
              slow.body = input.body;
              resolve({ status: "saved", page: { ...slow }, newMentions: [] });
            };
          });
        }
        return Promise.resolve({ status: "saved", page: { ...slow, version: input.expectedVersion + 1 }, newMentions: [] });
      },
      touch: async () => ({ ...slow }),
      favourite: async () => ({ ...slow }),
    };
    await act(async () => {
      root.render(createElement(DocsScreen, { onClose: () => {}, gateway: slowGateway, idleMs: 50 }));
    });
    await flush();
    await act(async () => {
      button("Bravo").click();
    });
    await flush();
    typeBlock("Still writing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(container.textContent).toContain("Saving is still waiting");
    expect(seen).toEqual([3]);
    release({ status: "saved", page: { ...slow }, newMentions: [] });
    await flush();
    typeBlock("Still writing more");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(seen[1]).toBe(8);
  });
});
