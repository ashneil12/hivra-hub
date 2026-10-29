// @vitest-environment happy-dom
// r75 (blind s06, B12): a Lead that asked Ash before starting any job showed red on Today and Being built, but its row
// on the Monos list had nothing. Its row now carries the red Needs you and opens the waiting chat.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteChats, resetWaitingChats, setWaitingChatsHost } from "../../features/hub/model/waitingChats";
import { resetDelegationStore } from "../../features/monos/model/delegationStore";
import { createMono, updateMono } from "../../features/monos/model/mono";
import { resetMonoTeams } from "../../features/hub/model/monoTeams";
import { MonoRailSection } from "./MonoRailSection";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resetDelegationStore();
  resetMonoTeams();
  resetWaitingChats();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const mount = () =>
  act(() => root.render(createElement(MonoRailSection, { states: new Map(), onOpen: () => {}, onCreate: () => {}, onDelete: () => {} })));

describe("r75: a Mono's chat waiting on Ash is red on its rail row", () => {
  it("shows Needs you with Open <Lead>'s chat, which opens the waiting chat", () => {
    const lead = createMono(["/code/tally"]);
    updateMono(lead.id, (m) => ({ ...m, name: "Tally lead", sessionId: "tally-chat" }));
    const other = createMono();
    updateMono(other.id, (m) => ({ ...m, name: "Chief of Staff", sessionId: "cos-chat" }));
    const host = { liveQuestion: () => undefined, respond: vi.fn(), send: vi.fn(async () => true), open: vi.fn() };
    setWaitingChatsHost(host);
    noteChats([
      {
        id: "tally-chat",
        cwd: "/code/tally",
        title: "Tally lead",
        harness: "claude",
        busy: false,
        blocks: [
          { id: "u", role: "user", text: "have a worker add sharing", startedAt: 1 },
          { id: "a", role: "assistant", text: "Needs the user: everyone sees every tally, or private unless shared?\nMy pick: private." },
        ],
      } as never,
    ]);
    mount();
    const line = container.querySelector<HTMLElement>(`[data-mono-waiting="${lead.id}"]`);
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain("Needs you");
    expect(line!.title).toBe("everyone sees every tally, or private unless shared?");
    expect(container.querySelector(`[data-mono-waiting="${other.id}"]`)).toBeNull();
    const open = [...line!.querySelectorAll("button")].find((b) => /Tally lead/.test(b.textContent ?? ""));
    expect(open).toBeTruthy();
    act(() => open!.click());
    expect(host.open.mock.calls[0]?.[0]).toBe("tally-chat");
  });
});
