// @vitest-environment happy-dom
// A framed page that navigates keeps the same contentWindow (HTML spec: the WindowProxy lives as long as the iframe), so
// the host can't tell a navigation from WebKit's duplicate srcdoc `load` by comparing windows. It tells by the document:
// only the document built with this frame's nonce can say hello with it, and every `load` asks for a fresh hello.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageBridgeHost, type PageSources } from "./pageBridgeHost";

type Msg = Record<string, unknown>;
const NONCE = "n-4f1c";
const sources = {
  "agents.read": { read: () => ({ agents: [] }), subscribe: () => () => undefined },
  "jobs.read": { read: () => ({ jobs: [] }), subscribe: () => () => undefined },
  "needs.read": { read: () => ({ needs: [] }), subscribe: () => () => undefined },
  "rooms.read": { read: () => ({ rooms: [] }), subscribe: () => () => undefined },
} as unknown as PageSources;

let sent: Msg[];
let lost: number;
function host() {
  return new PageBridgeHost({
    pageId: "pg", title: "T", live: true, asks: ["agents.read"], approved: () => ["agents.read"], tapped: () => false,
    post: (m) => sent.push(m as Msg), sources, nonce: NONCE, helloMs: 1000, onLost: () => void (lost += 1),
  });
}
const call = (id: string) => ({ type: "hub:call", id, call: "agents.read" });
const replies = () => sent.filter((m) => m.type === "hub:reply");
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  lost = 0;
});
afterEach(() => vi.useRealTimers());

it("answers nothing before the document has said hello with this frame's nonce", async () => {
  const h = host();
  h.receive(call("c1"));
  h.receive({ type: "hub:hello", nonce: "someone-else" });
  h.receive(call("c2"));
  await flush();
  expect(replies()).toEqual([]);
});

it("a navigation that keeps the same window is a navigation: no hello after the load means the frame is rebuilt", async () => {
  const h = host();
  h.receive({ type: "hub:hello", nonce: NONCE });
  h.receive(call("c1"));
  await flush();
  expect(replies()).toHaveLength(1);
  // The page set location to about:blank: the same contentWindow fires `load` again, and nothing there can hello.
  h.loaded();
  expect(sent.filter((m) => m.type === "hub:ping")).toHaveLength(1);
  h.receive(call("c2"));
  await vi.advanceTimersByTimeAsync(1100);
  await flush();
  expect(replies()).toHaveLength(1);
  expect(lost).toBe(1);
});

it("a navigation to another document (it can't know the nonce) is refused at once and the frame is rebuilt", async () => {
  const h = host();
  h.receive({ type: "hub:hello", nonce: NONCE });
  h.loaded();
  h.receive({ type: "hub:hello", nonce: "another-page's-nonce" });
  h.receive(call("c1"));
  await flush();
  expect(replies()).toEqual([]);
  expect(lost).toBe(1);
});

it("WebKit's duplicate load of the same srcdoc document answers the ping with the nonce and keeps its bridge", async () => {
  const h = host();
  h.receive({ type: "hub:hello", nonce: NONCE });
  h.loaded();
  h.loaded(); // the duplicate event
  h.receive({ type: "hub:hello", nonce: NONCE });
  h.receive(call("c1"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(replies()).toEqual([{ type: "hub:reply", id: "c1", ok: true, result: { agents: [] } }]);
  expect(lost).toBe(0);
});

it("a call made between load and the hello waits for it instead of being dropped, and is never answered if the hello never comes", async () => {
  const h = host();
  h.loaded();
  h.receive(call("c1"));
  await flush();
  expect(replies()).toEqual([]);
  h.receive({ type: "hub:hello", nonce: NONCE });
  await flush();
  expect(replies().map((m) => m.id)).toEqual(["c1"]);

  const gone = host();
  gone.loaded();
  gone.receive(call("c2"));
  await vi.advanceTimersByTimeAsync(1100);
  expect(replies().map((m) => m.id)).toEqual(["c1"]);
});
