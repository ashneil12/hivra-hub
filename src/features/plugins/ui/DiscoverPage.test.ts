// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PluginsPage } from "./DiscoverPage";
import { SOURCES_KEY } from "../model/discover";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const COMMIT = "6ea74587e384e1a8035c09ae33a46fe3f881eb9b";

function entry(name: string, patch: Record<string, unknown> = {}) {
  return {
    name,
    title: name,
    description: `${name} does a thing.`,
    keywords: [],
    platforms: [],
    adds: [{ kind: "skills", count: 1, names: ["one"] }],
    leftOut: [],
    permissions: [],
    status: "available",
    format: "hivra",
    ...patch,
  };
}

function payload(extra: unknown[] = []) {
  return [
    {
      source: { kind: "bundled" },
      index: {
        title: "Hivra plugins",
        format: "hivra",
        skipped: [],
        entries: [
          entry("pstack", {
            title: "pstack",
            description: "Skills for rigor.",
            author: "Lauren Tan",
            license: "MIT",
            permissions: ["Reads the repository"],
            adds: [{ kind: "skills", count: 2, names: ["architect", "tdd"] }],
            source: { kind: "git", url: "https://github.com/cursor/plugins", commit: COMMIT, path: "pstack" },
          }),
          entry("browser", {
            title: "Browser",
            description: "A real browser.",
            status: "planned",
            reason: "Not published yet. It arrives in WP-43.",
            adds: [{ kind: "mcpServers", count: 1, names: ["browser"] }],
            source: undefined,
          }),
          entry("dsh-only", {
            title: "DSH only",
            description: "Runs inside DeepSeek Harness.",
            status: "not-compatible",
            reason: "A DeepSeek Harness bundle.",
            adds: [],
          }),
          entry("windows-only", {
            title: "Windows only",
            description: "Windows.",
            status: "not-this-platform",
            reason: "This computer isn't one of its platforms.",
            platforms: ["windows"],
          }),
        ],
      },
    },
    {
      source: { kind: "url", url: "https://example.com/down.json" },
      error: "The index didn't answer. Nothing was listed.",
    },
    ...extra,
  ];
}

let root: Root;
let container: HTMLElement;
let alive = true;

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function render() {
  await act(async () => {
    root.render(createElement(PluginsPage));
  });
  for (let i = 0; i < 5 && !container.querySelector("[data-plugin]"); i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function submitAdd() {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Add");
  await act(async () => {
    button!.click();
  });
}

// Node's own localStorage is not a store. The page reads `localStorage` and writes `window.localStorage`, so both are this one.
function installStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
  return storage;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installStorage();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command: string) => (command === "plugins_discover" ? payload() : undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (alive && root) await act(async () => root.unmount());
  alive = true;
  container?.remove();
  vi.unstubAllGlobals();
});

const plugin = (name: string) => container.querySelector<HTMLElement>(`[data-plugin="${name}"]`);
const text = () => container.textContent ?? "";

describe("Discover (WP-32)", () => {
  it("lists a plugin with its licence, source, what it adds and its permissions, and offers Install only when it can", async () => {
    await render();
    expect(plugin("pstack")?.dataset.status).toBe("available");
    expect(container.querySelector("[data-licence]")?.textContent).toBe("MIT");
    expect(container.querySelector("[data-source]")?.textContent).toBe(`https://github.com/cursor/plugins at ${COMMIT.slice(0, 7)} (pstack)`);
    expect(container.querySelector("[data-adds]")?.textContent).toContain("2 skills");
    expect(container.querySelector("[data-adds]")?.textContent).toContain("architect, tdd");
    expect(container.querySelector("[data-permissions]")?.textContent).toContain("Reads the repository");
    expect(container.querySelector("[data-install]")).not.toBeNull();

    await act(async () => plugin("browser")!.click());
    expect(container.querySelector("[data-detail]")?.getAttribute("aria-label")).toBe("Browser");
    expect(container.querySelector("[data-install]")).toBeNull();
    expect(text()).toContain("Not published yet");

    await act(async () => plugin("dsh-only")!.click());
    expect(plugin("dsh-only")?.dataset.status).toBe("not-compatible");
    expect(container.querySelector("[data-install]")).toBeNull();
    expect(text()).toContain("A DeepSeek Harness bundle.");

    await act(async () => plugin("windows-only")!.click());
    expect(plugin("windows-only")?.dataset.status).toBe("not-this-platform");
    expect(container.querySelector("[data-install]")).toBeNull();
    expect(text()).toContain("Not for this computer");
  });

  it("filters by what a plugin adds and searches the text", async () => {
    await render();
    const mcp = [...container.querySelectorAll("button")].find((button) => button.textContent === "MCP servers")!;
    await act(async () => mcp.click());
    expect(mcp.getAttribute("aria-pressed")).toBe("true");
    expect(plugin("browser")).not.toBeNull();
    expect(plugin("pstack")).toBeNull();

    const all = [...container.querySelectorAll("button")].find((button) => button.textContent === "All")!;
    await act(async () => all.click());
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search plugins"]')!;
    await act(async () => setValue(search, "LAUREN"));
    expect(plugin("pstack")).not.toBeNull();
    expect(plugin("browser")).toBeNull();
    expect(text()).not.toContain("No plugins match.");
  });

  it("treats a missing install command as a failure and never says the plugin was installed", async () => {
    await render();
    await act(async () => plugin("pstack")!.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-install]")!.click();
    });
    const install = vi.mocked(invoke).mock.calls.filter((call) => call[0] === "plugins_install");
    expect(install).toEqual([
      ["plugins_install", {
        source: { kind: "git", url: "https://github.com/cursor/plugins", commit: COMMIT, path: "pstack" },
        requestedBy: { kind: "person" },
      }],
    ]);
    expect(container.querySelector("[data-installed]")).toBeNull();
    expect(container.querySelector("[data-install-error]")?.textContent).toBe("Install isn't in this build yet. Nothing was installed.");
    expect(container.querySelector("[data-install]")).not.toBeNull();
  });

  it("says a person's install is in, and off until they switch it on", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "plugins_discover") return payload();
      if (command === "plugins_install") return { status: "installed", entry: { name: "pstack" }, reports: [] };
      return undefined;
    });
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-install]")!.click();
    });
    expect(container.querySelector("[data-installed]")?.textContent).toBe(
      "Installed pstack. It's off until you switch it on in Settings > Plugins.",
    );
    expect(container.querySelector("[data-install]")).toBeNull();
    expect(container.textContent).not.toContain("Installed.");
  });

  it("shows a waiting install, including the commands, and never says it was installed", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "plugins_discover") return payload();
      if (command === "plugins_install") {
        return { status: "waiting", request: { steps: [{ run: ["npm", "install"], cwd: ".", why: "dependencies" }] } };
      }
      return undefined;
    });
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-install]")!.click();
    });
    expect(container.querySelector("[data-installed]")?.textContent).toBe(
      "Waiting for your OK in the Inbox. npm install",
    );
    expect(container.querySelector("[data-installed]")?.textContent).not.toContain("Installed");
    expect(container.querySelector("[data-install]")).toBeNull();
  });

  it("treats a result that is not installed or waiting as a failure", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "plugins_discover") return payload();
      if (command === "plugins_install") return { message: "Installed." };
      return undefined;
    });
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-install]")!.click();
    });
    expect(container.querySelector("[data-installed]")).toBeNull();
    expect(container.querySelector("[data-install-error]")?.textContent).toBe("It wasn't installed.");
    expect(container.textContent).not.toContain("Installed.");
  });

  it("keeps the last list when a refresh fails, and a late listing cannot replace it", async () => {
    localStorage.setItem(SOURCES_KEY, JSON.stringify({
      revision: 1,
      sources: [{ kind: "bundled" }, { kind: "url", url: "https://example.com/down.json" }],
    }));
    let resolveLate: (value: unknown) => void = () => {};
    let calls = 0;
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command !== "plugins_discover") return Promise.resolve(undefined);
      calls += 1;
      if (calls === 1) return Promise.resolve(payload());
      if (calls === 2) return new Promise((resolve) => { resolveLate = resolve; });
      return Promise.reject(new Error("The index didn't answer. Nothing was listed."));
    });
    await render();
    expect(plugin("pstack")).not.toBeNull();

    const again = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => again.click());
    const during = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Try again");
    await act(async () => during[0]!.click());
    expect(plugin("pstack")).not.toBeNull();
    expect(text()).toContain("Nothing was marked not compatible.");
    expect(plugin("pstack")?.dataset.status).toBe("available");

    await act(async () => {
      resolveLate([{
        source: { kind: "bundled" },
        index: { title: "Late", format: "hivra", skipped: [], entries: [entry("late-only")] },
      }]);
    });
    expect(plugin("late-only")).toBeNull();
    expect(plugin("pstack")).not.toBeNull();
  });

  it("shows an unreachable index as something to try again, not as a plugin that is not compatible", async () => {
    localStorage.setItem(SOURCES_KEY, JSON.stringify({
      revision: 1,
      sources: [{ kind: "bundled" }, { kind: "url", url: "https://example.com/down.json" }],
    }));
    await render();
    const errors = [...container.querySelectorAll("[data-index-error]")].map((node) => node.textContent);
    expect(errors.some((line) => line?.includes("The index didn't answer."))).toBe(true);
    expect(errors.some((line) => line?.includes("Not compatible"))).toBe(false);
    expect(plugin("pstack")?.dataset.status).toBe("available");
    expect([...container.querySelectorAll("[data-index-error] button")].some((button) => button.textContent === "Try again")).toBe(true);
  });

  it("drops a listing that arrives after the page is gone", async () => {
    let resolveLate: (value: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementation((command: string) => command === "plugins_discover"
      ? new Promise((resolve) => { resolveLate = resolve; })
      : Promise.resolve(undefined));
    await render();
    await act(async () => root.unmount());
    alive = false;
    await act(async () => {
      resolveLate(payload());
    });
    expect(container.querySelector("[data-plugin]")).toBeNull();
  });

  it("keeps another window's list when this one would overwrite it", async () => {
    await render();
    localStorage.setItem(SOURCES_KEY, JSON.stringify({
      revision: 5,
      sources: [{ kind: "url", url: "https://example.com/other.json" }],
    }));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Index address"]')!;
    await act(async () => setValue(input, "https://example.com/mine.json"));
    await submitAdd();
    expect(container.querySelector("[data-discover-notice]")?.textContent).toBe("The index list changed in another window. Showing that list.");
    expect(text()).toContain("https://example.com/other.json");
    expect(text()).not.toContain("https://example.com/mine.json");
    expect(JSON.parse(localStorage.getItem(SOURCES_KEY)!).revision).toBe(5);
  });

  it("tells you when the list cannot be saved, and never leaves it empty", async () => {
    await render();
    const storage = window.localStorage;
    const setItem = storage.setItem.bind(storage);
    storage.setItem = () => { throw new Error("quota"); };
    try {
      const input = container.querySelector<HTMLInputElement>('[aria-label="Index address"]')!;
      await act(async () => setValue(input, "https://example.com/mine.json"));
      await submitAdd();
      expect(text()).toContain("Couldn't save the index list on this computer.");
      expect(text()).toContain("Hivra's own index");
      expect(localStorage.getItem(SOURCES_KEY)).toBeNull();
    } finally {
      storage.setItem = setItem;
    }

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Remove Hivra\'s own index"]')!.click();
    });
    expect(text()).toContain("Hivra's own index");
    expect(JSON.parse(localStorage.getItem(SOURCES_KEY)!).sources).toEqual([{ kind: "bundled" }]);
  });

  it("refuses a bad address and keeps a file path as it was typed", async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('[aria-label="Index address"]')!;
    await act(async () => setValue(input, "http://example.com/index.json"));
    await submitAdd();
    expect(container.querySelector("[data-draft-error]")?.textContent).toBe("An index address has to be https.");
    expect(container.querySelectorAll("[data-index-source]")).toHaveLength(1);

    const kind = container.querySelector<HTMLSelectElement>('[aria-label="Kind of index"]')!;
    await act(async () => setValue(kind, "file"));
    await act(async () => setValue(input, "C:\\Users\\A b\\索引.json\r\n"));
    await submitAdd();
    expect(container.querySelector("[data-draft-error]")).toBeNull();
    expect(text()).toContain("C:\\Users\\A b\\索引.json");
  });
});
