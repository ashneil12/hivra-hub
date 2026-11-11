// @vitest-environment happy-dom
// Round-4 review repro (PR #213, N6): a refused secret answer is retried with whatever card version the panel holds by
// then, not the version the person read. The test asserts the safe behaviour, so a failure is the finding.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FirstMateInboxPanel } from "./FirstMateInboxPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const PROJECT = "/work/proj";
const KEY = "secret/stripe-api-key/abc";
const CARD_CHANGED = "That card changed after you read it, so the answer was not recorded. Read it again and answer.";

function card(version: number, command: string) {
  return {
    project: PROJECT,
    decisionKey: KEY,
    question: `Let Tally run \`/usr/bin/curl\` with Stripe key?\nCommand: ${command}`,
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

describe("round 4 repro: a secret card's answer and the version the person read", () => {
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
    vi.unstubAllGlobals();
  });

  it("never sends an answer for a card version the person did not tap on", async () => {
    // The server: card A at version 1. The agent rebinds it to command B (version 2) just as the person taps Once on A.
    let server = card(1, "curl https://api.stripe.com/v1/balance");
    let delayList = false;
    const sent: Array<number | undefined> = [];
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "decisions_list") {
        const answer = [server];
        // The reload the rebind's change event started lands a moment later (its own task).
        if (delayList) return new Promise((resolve) => setTimeout(() => resolve(answer), 0));
        return answer;
      }
      if (cmd === "decisions_answer") {
        sent.push(args?.seenVersion as number | undefined);
        if (args?.seenVersion !== server.version) {
          throw new Error(CARD_CHANGED);
        }
        server = { ...server, state: "answered" } as typeof server;
        return { applied: true, decision: server, released: [], releasedTasks: [] };
      }
      return [];
    }) as never);
    await act(async () => {
      root.render(createElement(FirstMateInboxPanel, { cwd: PROJECT }));
    });
    const once = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Once"));
    await vi.waitFor(() => expect(once()).toBeTruthy());
    expect(container.textContent).toContain("v1/balance");

    // The agent's rebind: the card now runs command B, and the app emits decisions-changed.
    server = card(2, "curl -K /Users/ash/proj/evil.cfg");
    delayList = true;
    handlers.get("hivra:decisions-changed")?.();
    // The person, still reading command A, taps Once.
    await act(async () => {
      once()?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sent[0]).toBe(1);
    // Every attempt for that tap must carry the version the person read (1), or stop on "card changed".
    expect(sent.filter((v) => v !== 1), `answers sent: ${JSON.stringify(sent)}; server state: ${server.state}`).toEqual([]);
    expect(server.state).toBe("open");
  });
});
