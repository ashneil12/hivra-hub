// @vitest-environment happy-dom
// WP-104: the health list a person sees, and what happens when a check is late or fails.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthRows, LOW_DISK_BYTES, type HealthFacts } from "../model/health";
import { HealthList, useHealth } from "./HealthList";

const NOW = Date.parse("2026-11-09T12:00:00Z");

function facts(extra: Partial<HealthFacts> = {}): HealthFacts {
  return {
    clis: [{ id: "claude", name: "Claude Code", installed: false, signedIn: null }],
    git: { state: "ok", version: "git version 2.39.2" },
    diskFreeBytes: LOW_DISK_BYTES - 1,
    database: "problem",
    dataWritable: true,
    plugins: "missing",
    lastBackupAt: null,
    now: NOW,
    gateway: { name: "Ollama", state: "down" },
    ...extra,
  };
}

function Live({ load, intervalMs }: { load: () => Promise<HealthFacts>; intervalMs: number }) {
  const health = useHealth(load, intervalMs);
  return createElement(HealthList, { rows: health.rows, pending: health.pending, note: health.note });
}

function visible(node: ReturnType<typeof createElement>): string {
  const holder = document.createElement("div");
  holder.innerHTML = renderToStaticMarkup(node);
  return holder.textContent ?? "";
}

describe("health list", () => {
  it("shows OK, Check this and Problem in plain words", () => {
    const html = renderToStaticMarkup(createElement(HealthList, { rows: healthRows(facts()) }));
    const text = visible(createElement(HealthList, { rows: healthRows(facts()) }));
    expect(text).toContain("OK. Git is installed (git version 2.39.2).");
    expect(text).toContain("OK. No plugins folder yet.");
    expect(text).toContain("Check this. Less than 2 GB is free. Free some space before a long run.");
    expect(text).toContain("Check this. Couldn't reach Ollama this time. It will be checked again shortly.");
    expect(text).toContain("Problem. Claude Code is not installed. Install it, then open Hivra again.");
    expect(text).toContain("Problem. The app database failed its check. Copy diagnostics before you keep working.");
    expect(html).toContain('data-tone="ok"');
    expect(html).toContain('data-tone="check"');
    expect(html).toContain('data-tone="problem"');
  });

  it("says it is checking, and says when a check could not start", () => {
    expect(visible(createElement(HealthList, { rows: [], pending: true }))).toContain("Checking.");
    expect(visible(createElement(HealthList, { rows: [], note: "Couldn't check just now. It will try again." }))).toContain(
      "Couldn't check just now. It will try again.",
    );
  });
});

describe("health refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  let open = false;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    open = true;
  });

  afterEach(async () => {
    if (open) await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render(load: () => Promise<HealthFacts>, intervalMs = 1_000) {
    await act(async () => {
      root.render(createElement(Live, { load, intervalMs }));
    });
  }

  it("keeps the last rows when a later check fails", async () => {
    let calls = 0;
    await render(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(facts());
      return Promise.reject(new Error("down"));
    });
    expect(container.textContent).toContain("Claude Code is not installed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(container.textContent).toContain("Claude Code is not installed");
    expect(container.textContent).toContain("Couldn't refresh just now. Showing the last check.");
  });

  it("shows a miss when the first check fails", async () => {
    await render(() => Promise.reject(new Error("down")));
    expect(container.textContent).toContain("Couldn't check just now. It will try again.");
    expect(container.textContent).not.toContain("Claude Code");
  });

  it("ignores a late failure and keeps a newer success", async () => {
    let release: (facts: HealthFacts) => void = () => {};
    let calls = 0;
    await render(() => {
      calls += 1;
      if (calls === 1) return new Promise<HealthFacts>((resolve) => { release = resolve; });
      return Promise.resolve(facts({ clis: [], database: "ok", diskFreeBytes: LOW_DISK_BYTES, gateway: null }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(container.textContent).toContain("Git is installed");
    expect(container.textContent).not.toContain("not installed");
    await act(async () => {
      release(facts());
    });
    expect(container.textContent).not.toContain("not installed");
    expect(container.textContent).toContain("The app database looks fine.");
  });

  it("still applies a slow success that lands after a newer miss", async () => {
    let release: (facts: HealthFacts) => void = () => {};
    let calls = 0;
    await render(() => {
      calls += 1;
      if (calls === 1) return new Promise<HealthFacts>((resolve) => { release = resolve; });
      return Promise.reject(new Error("down"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(container.textContent).toContain("Couldn't check just now. It will try again.");
    await act(async () => {
      release(facts({ clis: [], database: "ok", diskFreeBytes: LOW_DISK_BYTES, gateway: null }));
    });
    expect(container.textContent).toContain("The app database looks fine.");
    expect(container.textContent).not.toContain("Couldn't check just now");
  });

  it("stops checking after the page closes", async () => {
    let calls = 0;
    await render(() => {
      calls += 1;
      return Promise.resolve(facts());
    });
    expect(calls).toBe(1);
    await act(async () => root.unmount());
    open = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(calls).toBe(1);
  });
});
