import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { HostEngine } from "../engine";
import { HostStore } from "../store";
import { createHostServer } from "../server";
import type { SendTurnInput } from "../../src/integrations/harness/core/types";
import type { CatchUpEntry } from "../../src/features/firstmate/host/types";
import { retryableFailure } from "./service";

const leaseGate = vi.hoisted(() => ({ refuse: false }));
vi.mock("./lease", async () => {
  const actual = await vi.importActual<typeof import("./lease")>("./lease");
  return {
    ...actual,
    acquireSessionLease: (sessionId: string, root: string) =>
      leaseGate.refuse ? null : actual.acquireSessionLease(sessionId, root),
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  leaseGate.refuse = false;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Turn = { input: SendTurnInput; resolve: () => void; reject: (error: Error) => void };

async function setup(sendBehavior: "hold" | "refuse" = "hold") {
  const directory = mkdtempSync(join(tmpdir(), "fm-host-"));
  const store = new HostStore(join(directory, "host.db"));
  const pending: Turn[] = [];
  const send = vi.fn((input: SendTurnInput) => {
    if (sendBehavior === "refuse") {
      return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9"));
    }
    return new Promise<void>((resolve, reject) => {
      pending.push({ input, resolve, reject });
    });
  });
  const engine = new HostEngine(store, {
    codex: { send, stop: async () => {}, cancel: async () => {}, bind: () => {}, approve: () => {}, answer: () => {} },
  });
  const project = await engine.openProject(directory);
  const server = createHostServer(engine, ["codex"]);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  const device = store.issueDevice("Laptop");
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${device.token}` },
      body: JSON.stringify({ version: 1, environmentId: store.environmentId, method, params }),
    });
    return { status: response.status, value: (await response.json()) as { result?: any; error?: string } };
  };
  cleanups.push(async () => {
    for (const turn of pending.splice(0)) turn.resolve();
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    project,
    call,
    send,
    finish: () => {
      const turn = pending.shift();
      if (!turn) throw new Error("no turn to finish");
      turn.input.onEvent({ type: "message.delta", text: "The change is in." });
      turn.input.onEvent({ type: "message.completed" });
      turn.resolve();
    },
  };
}

const brief = (projectId: string, patch: Record<string, unknown> = {}) => ({
  projectId,
  launchKey: "brief-1",
  ownerSession: "owner-1",
  title: "Ship the fix",
  brief: "Change the copy.",
  harness: "codex",
  model: "codex:test",
  runtimeMode: "supervised",
  startedBy: "person",
  ...patch,
});

describe("host first mate", () => {
  it("finishes one brief while the desktop is away, and a reconnect race does not start a second worker", async () => {
    const host = await setup();
    const params = brief(host.project.id);
    const [first, second] = await Promise.all([
      host.call("firstmate.brief", params),
      host.call("firstmate.brief", params),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.value.result.delegation.id).toBe(second.value.result.delegation.id);
    expect([first.value.result.created, second.value.result.created].filter(Boolean)).toHaveLength(1);
    await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(1));
    expect(host.store.summaries(host.project.id)).toHaveLength(1);

    const whileRunning = await host.call("firstmate.brief", params);
    expect(whileRunning.status).toBe(200);
    expect(whileRunning.value.result.delegation.id).toBe(first.value.result.delegation.id);
    expect(host.send).toHaveBeenCalledTimes(1);

    const conflict = await host.call("firstmate.brief", { ...params, title: "A different brief" });
    expect(conflict.status).toBe(400);
    expect(conflict.value.error).toMatch(/launch_key already belongs to a different request/);
    expect(host.store.summaries(host.project.id)).toHaveLength(1);

    // The desktop is gone. The host finishes the turn on its own.
    host.finish();
    let seq = 0;
    await vi.waitFor(async () => {
      const page = await host.call("firstmate.catchUp", { projectId: host.project.id });
      const finished = (page.value.result.entries as CatchUpEntry[]).filter((entry) => entry.kind === "finished");
      expect(finished).toHaveLength(1);
      expect(finished[0].text).toContain("The change is in.");
      expect(finished[0].startedBy).toBe("person");
      seq = finished[0].seq;
    });
    const again = await host.call("firstmate.catchUp", { projectId: host.project.id, after: seq });
    expect(again.value.result.entries).toEqual([]);

    const retry = await host.call("firstmate.brief", params);
    expect(retry.status).toBe(200);
    expect(retry.value.result.created).toBe(false);
    expect(host.send).toHaveBeenCalledTimes(1);
    expect(host.store.summaries(host.project.id)).toHaveLength(1);

    const wakes = await host.call("firstmate.wakes", { projectId: host.project.id });
    // A finished brief is a report, carried by catch-up. It is not left on the wake table.
    expect(wakes.value.result).toEqual([]);
  });

  it("stamps a schedule and a first mate on the runs they started", async () => {
    const host = await setup();
    for (const startedBy of ["schedule", "first-mate"] as const) {
      const started = await host.call("firstmate.brief", brief(host.project.id, {
        launchKey: `by-${startedBy}`,
        title: `From ${startedBy}`,
        startedBy,
      }));
      expect(started.status).toBe(200);
      expect(started.value.result.delegation.startedBy).toBe(startedBy);
    }
    await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(2));
    host.finish();
    host.finish();
    await vi.waitFor(async () => {
      const page = await host.call("firstmate.catchUp", { projectId: host.project.id });
      const finished = (page.value.result.entries as CatchUpEntry[]).filter((entry) => entry.kind === "finished");
      expect(finished.map((entry) => entry.startedBy).sort()).toEqual(["first-mate", "schedule"]);
    });
  });

  it("records an unreachable provider as retryable and sends that same launch again", async () => {
    const host = await setup("refuse");
    const params = brief(host.project.id, { launchKey: "unreachable" });
    const started = await host.call("firstmate.brief", params);
    expect(started.status).toBe(200);
    await vi.waitFor(async () => {
      const page = await host.call("firstmate.catchUp", { projectId: host.project.id });
      const failed = (page.value.result.entries as CatchUpEntry[]).find((entry) => entry.kind === "failed");
      expect(failed?.text).toMatch(/ECONNREFUSED/);
      expect(failed?.startedBy).toBe("person");
      expect(failed?.ownerSession).toBe("owner-1");
    });
    const row = (await host.call("firstmate.list", { projectId: host.project.id })).value.result[0];
    expect(row.retryable).toBe(true);
    expect(row.state).toBe("failed");
    const again = await host.call("firstmate.brief", params);
    expect(again.status).toBe(200);
    expect(again.value.result.delegation.id).toBe(row.id);
    expect(again.value.result.created).toBe(false);
    expect(again.value.result.delegation.state).toBe("running");
    await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(2));
    expect(host.store.summaries(host.project.id)).toHaveLength(1);
  });

  it("treats a timeout, an unreachable provider and a host restart as retryable", () => {
    expect(retryableFailure("The request timed out")).toBe(true);
    expect(retryableFailure("connect ECONNREFUSED 127.0.0.1:9")).toBe(true);
    expect(retryableFailure("Host restarted")).toBe(true);
    expect(retryableFailure("Host stopped. This turn was interrupted.")).toBe(true);
    expect(retryableFailure("Session storage failed during this turn.")).toBe(true);
    expect(retryableFailure("The brief was refused.")).toBe(false);
  });

  it("fails a brief whose session lease is refused, and the same launch can be sent once the session is free", async () => {
    leaseGate.refuse = true;
    const host = await setup();
    const params = brief(host.project.id, { launchKey: "leased" });
    const started = await host.call("firstmate.brief", params);
    expect(started.status).toBe(200);
    const row = (await host.call("firstmate.list", { projectId: host.project.id })).value.result[0];
    expect(row.state).toBe("failed");
    expect(row.retryable).toBe(true);
    expect(row.error).toMatch(/in use/);
    expect(row.error).not.toMatch(/pid|EPERM|\//i);
    expect(host.send).not.toHaveBeenCalled();
    expect(host.store.summaries(host.project.id)).toHaveLength(1);

    leaseGate.refuse = false;
    const again = await host.call("firstmate.brief", params);
    expect(again.status).toBe(200);
    expect(again.value.result.delegation.id).toBe(row.id);
    expect(again.value.result.created).toBe(false);
    await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(1));
    expect(host.store.summaries(host.project.id)).toHaveLength(1);
  });

  it("rejects an empty brief, an unsafe launch key and an unknown project before starting a worker", async () => {
    const host = await setup();
    const params = brief(host.project.id);
    expect((await host.call("firstmate.brief", { ...params, brief: "   " })).status).toBe(400);
    expect((await host.call("firstmate.brief", { ...params, launchKey: "a/b" })).status).toBe(400);
    expect((await host.call("firstmate.brief", { ...params, launchKey: ".." })).status).toBe(400);
    expect((await host.call("firstmate.brief", { ...params, startedBy: "cron" })).status).toBe(400);
    expect((await host.call("firstmate.catchUp", { projectId: host.project.id, after: -1 })).status).toBe(400);
    const missing = await host.call("firstmate.brief", { ...params, projectId: "missing" });
    expect(missing.status).toBe(400);
    expect(missing.value.error).toMatch(/not registered/);
    expect(host.send).not.toHaveBeenCalled();
    expect(host.store.summaries(host.project.id)).toEqual([]);
  });
});
