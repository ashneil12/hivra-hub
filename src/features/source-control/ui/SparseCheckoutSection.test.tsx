// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SparseCheckoutSection } from "./SparseCheckoutSection";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

const UNREADABLE = "The saved setting can't be read, so sparse checkout stays off.";
const CONFLICT = "This setting changed in another window. Look again, then change it.";

let container: HTMLDivElement;
let root: Root;

async function render(cwd: string) {
  await act(async () => {
    root.render(createElement(SparseCheckoutSection, { cwd }));
  });
}

function switchButton(): HTMLButtonElement {
  const node = container.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!node) throw new Error("missing switch");
  return node;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("sparse checkout setting", () => {
  it("paints off before a reply and stays off when the reply is empty", async () => {
    let resolve: (value: unknown) => void = () => {};
    vi.mocked(invoke).mockReturnValue(new Promise((done) => {
      resolve = done;
    }));
    await act(async () => {
      root.render(createElement(SparseCheckoutSection, { cwd: "/repo" }));
    });
    expect(container.querySelector("[data-setting-id='sparse-checkout']")).not.toBeNull();
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(
      "Use a sparse checkout for new worktrees on this project",
    );
    await act(async () => {
      resolve(undefined);
    });
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
  });

  it("drops a late reply after the project changes", async () => {
    const pending: Array<(value: unknown) => void> = [];
    vi.mocked(invoke).mockImplementation(
      () => new Promise((done) => pending.push(done)),
    );
    await render("/repo/a");
    await render("/repo/b");
    await act(async () => {
      pending[0]?.({ enabled: true, readable: true });
    });
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      pending[1]?.({ enabled: true, readable: true });
    });
    expect(switchButton().getAttribute("aria-checked")).toBe("true");
  });

  it("says when the saved setting can't be read and keeps the switch off", async () => {
    vi.mocked(invoke).mockResolvedValue({ enabled: false, readable: false });
    await render("/repo");
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(UNREADABLE);
  });

  it("puts the switch back when another window saved first", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "sparse_checkout_settings") return { enabled: false, readable: true };
      throw CONFLICT;
    });
    await render("/repo");
    await act(async () => switchButton().click());
    expect(switchButton().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(CONFLICT);
  });
});
