// Review repro for PR #194 round 5: an agent session's process must pass the crew spawn gate (crew_spawn_ticket, then
// harness_spawn) whichever path started it. OpenCode 1.x spawns `opencode serve` through spawnChild, so it asks for the
// ticket. OpenCode 2.x talks to the background service (harness_exec "service start" and HTTP) and never asks: a phase
// worker, a resumed worker or a woken worker on OpenCode 2.x runs with no Never use or lock check in Rust at all.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoked: string[] = [];
let openCodeVersion = "opencode 1.14.19";
let onStdout: ((line: string) => void) | undefined;
let onSseEvent: ((event: Record<string, unknown>) => void) | undefined;
let bindRefusal: string | undefined;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    invoked.push(command);
    if (command === "crew_spawn_ticket") return "ticket-1";
    if (command === "crew_bind_v2_session" && bindRefusal) throw new Error(bindRefusal);
    if (command === "harness_spawn") {
      queueMicrotask(() => onStdout?.("opencode server listening on http://127.0.0.1:4096"));
      return 4242;
    }
    return undefined;
  }),
}));

const harnessHttp = vi.fn(async (input: { url: string; method: string }) => {
  const url = new URL(input.url);
  if (input.method === "POST" && url.pathname === "/api/session")
    return { status: 200, body: JSON.stringify({ data: { id: "session_1", location: { directory: "/repo" } } }) };
  if (input.method === "POST" && url.pathname === "/session")
    return { status: 200, body: JSON.stringify({ id: "session_1", directory: "/repo" }) };
  if (input.method === "GET" && /message$/.test(url.pathname)) return { status: 200, body: JSON.stringify({ data: [] }) };
  return { status: 204, body: "" };
});

vi.mock("../../core/child", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/child")>();
  return {
    ...real,
    // spawnChild stays real: it is where the crew spawn ticket is asked for.
    closeHarnessSse: async () => undefined,
    execChild: async (_command: string, args: string[]) =>
      args[0] !== "service" ? openCodeVersion : args[1] === "get" ? "secret" : "http://127.0.0.1:4096",
    freeHarnessPort: async () => 4096,
    harnessHttp,
    killChild: async () => undefined,
    openHarnessSse: async () => undefined,
    resolveOpenCodeBinary: async () => ({ path: "/fake/opencode" }),
    unwatchChild: () => undefined,
    watchChild: (_id: string, stdout: (line: string) => void) => {
      onStdout = stdout;
    },
    watchSse: (_id: string, event: (data: string) => void) => {
      onSseEvent = (value) => event(JSON.stringify(value));
    },
  };
});

const { __openCodeTestReset, sendOpenCodeTurn, stopOpenCodeSession } = await import("./opencode");

const SESSION = "app-mono-lead-r1-phase-run1";

async function startTurn(): Promise<void> {
  void sendOpenCodeTurn({
    sessionId: SESSION,
    cwd: "/repo",
    model: "opencode:openrouter/anthropic/claude-sonnet-4.6",
    runtimeMode: "full-access",
    text: "write the research phase",
    attachments: [],
    onEvent: () => {},
  }).catch(() => undefined);
  for (let index = 0; index < 200; index += 1) {
    if (harnessHttp.mock.calls.some(([input]) => /\/prompt(_async)?$/.test(new URL(input.url).pathname))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the turn never reached OpenCode");
}

beforeEach(() => {
  invoked.length = 0;
  onStdout = undefined;
  onSseEvent = undefined;
  harnessHttp.mockClear();
  __openCodeTestReset();
});

afterEach(async () => {
  onSseEvent?.({ type: "session.status", properties: { sessionID: "session_1", status: { type: "idle" } } });
  await stopOpenCodeSession(SESSION);
  __openCodeTestReset();
});

it("control: an agent session on OpenCode 1.x asks for its crew spawn ticket before it runs", async () => {
  openCodeVersion = "opencode 1.14.19";
  await startTurn();
  expect(invoked).toContain("crew_spawn_ticket");
});

it("an agent session on OpenCode 2.x asks for its crew spawn ticket before it runs", async () => {
  openCodeVersion = "opencode v2.0.15";
  await startTurn();
  expect(invoked).toContain("crew_spawn_ticket");
});

// Round 6: the ticket the OpenCode 2.x service start mints is consumed by the bind. A refused bind creates no session.
it("a v2 session is not created when the bind refuses its crew ticket", async () => {
  openCodeVersion = "opencode v2.0.15";
  bindRefusal = "This crew gate ticket is unknown or was already used, so it was not started.";
  let thrown: unknown;
  void sendOpenCodeTurn({
    sessionId: SESSION,
    cwd: "/repo",
    model: "opencode:openrouter/anthropic/claude-sonnet-4.6",
    runtimeMode: "full-access",
    text: "write the research phase",
    attachments: [],
    onEvent: () => {},
  }).catch((error: unknown) => {
    thrown = error;
  });
  for (let index = 0; index < 100 && thrown === undefined; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  bindRefusal = undefined;
  expect(thrown).toBeInstanceOf(Error);
  const creates = harnessHttp.mock.calls.filter(
    ([input]) => input.method === "POST" && ["/api/session", "/session"].includes(new URL(input.url).pathname),
  );
  expect(creates).toEqual([]);
});
