// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { NOT_ASKED } from "../../pages/model/bridge";
import type { PageSources } from "../../pages/model/pageBridgeHost";
import { CSP, SANDBOX } from "../../pages/model/sandbox";
import type { PageSpec } from "../../pages/model/pageSpec";
import { panelDocument, panelGrants, panelHost } from "./panelSandbox";

const bespoke: PageSpec = {
  kind: "bespoke",
  title: "Example: board",
  html: "<p>Example: board</p>",
  permissions: ["tasks.read", "jobs.read"],
};

const sources: PageSources = {
  "agents.read": { read: () => ({ agents: [{ id: "other" }] }), subscribe: () => () => undefined },
  "jobs.read": { read: () => ({ jobs: [{ title: "Example: paint the sign" }] }), subscribe: () => () => undefined },
  "needs.read": { read: () => ({ needs: [], waiting: [] }), subscribe: () => () => undefined },
  "rooms.read": { read: () => ({ rooms: [] }), subscribe: () => () => undefined },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("renders in the Pages sandbox and grants only what the panel asked for", async () => {
  const doc = panelDocument(bespoke);
  expect(doc).toContain(CSP);
  expect(doc).toContain("connect-src 'none'");
  expect(doc).toContain("Example: board");
  expect(SANDBOX).toBe("allow-scripts");
  expect(panelGrants(bespoke)).toEqual(["tasks.read", "jobs.read"]);

  const sent: Record<string, unknown>[] = [];
  const host = panelHost(bespoke, (message) => sent.push(message as Record<string, unknown>), {
    "tasks.read": async () => ({ tasks: [{ title: "Example: waiting" }] }),
    "project.read": async () => ({ projects: [{ name: "should not run" }] }),
  }, sources);
  host.receive({ type: "hub:call", id: "c1", call: "tasks.read" });
  host.receive({ type: "hub:call", id: "c2", call: "project.read" });
  host.receive({ type: "hub:watch", id: "w1", call: "jobs.read" });
  host.receive({ type: "hub:watch", id: "w2", call: "agents.read" });
  host.receive({ type: "hub:call", id: "c3", call: "keys.read" });
  await flush();

  const replies = sent.filter((message) => message.type === "hub:reply");
  expect(replies.find((message) => message.id === "c1")).toMatchObject({ ok: true, result: { tasks: [{ title: "Example: waiting" }] } });
  expect(replies.find((message) => message.id === "c2")).toMatchObject({ ok: false, error: NOT_ASKED });
  expect(replies.find((message) => message.id === "w1")).toMatchObject({ ok: true });
  expect(replies.find((message) => message.id === "w2")).toMatchObject({ ok: false, error: NOT_ASKED });
  expect(replies.find((message) => message.id === "c3")).toMatchObject({ ok: false });
  expect(sent.find((message) => message.type === "hub:data" && message.call === "jobs.read")).toMatchObject({
    data: { jobs: [{ title: "Example: paint the sign" }] },
  });
  expect(sent.some((message) => message.call === "agents.read" && message.type === "hub:data")).toBe(false);
  host.dispose();
});

it("a blocks panel gets the same sandbox and no permissions", async () => {
  const spec: PageSpec = { kind: "blocks", title: "Board", blocks: [{ kind: "note", title: "Hello", text: "Example: a note" }] };
  const doc = panelDocument(spec);
  expect(doc).toContain(CSP);
  expect(doc).toContain("Example: a note");
  expect(panelGrants(spec)).toEqual([]);
  const sent: Record<string, unknown>[] = [];
  const host = panelHost(spec, (message) => sent.push(message as Record<string, unknown>), {
    "tasks.read": async () => ({ tasks: [] }),
  });
  host.receive({ type: "hub:call", id: "c1", call: "tasks.read" });
  await flush();
  expect(sent[0]).toMatchObject({ ok: false, error: NOT_ASKED });
  host.dispose();
});
