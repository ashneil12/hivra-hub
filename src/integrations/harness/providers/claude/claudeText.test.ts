// The small-model helper (titles, commit messages, the room's chime gate) against a stand-in for the Claude CLI that
// behaves like 2.1.30x does: it says nothing until it has a prompt (no "ready" before the first message), streams the
// answer, then spends seconds on a post-turn summary before its `result`. Measured on 20 Oct: the old helper waited 8 s
// for a ready line that never came, then waited for the summary, and ran one call at a time, so the room's gate queued
// behind chat titles.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Fake = {
  id: string;
  args: string[];
  written: string[];
  killed: boolean;
  spawnedAt: number;
  promptAt?: number;
};

const fakes = new Map<string, Fake>();
const watchers = new Map<string, { line: (l: string) => void; exit: () => void }>();
/** What the stand-in answers per prompt: text, and how long the model takes. */
let script: (prompt: string) => { text: string; thinkMs?: number; summaryMs?: number; fail?: string } = () => ({ text: "ok" });

const emit = (id: string, rec: Record<string, unknown>) => watchers.get(id)?.line(JSON.stringify(rec));

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (id: string, _path: string, args: string[]) => {
    if (fakes.has(id) && !fakes.get(id)!.killed) throw new Error(`child ${id} is already running`);
    fakes.set(id, { id, args, written: [], killed: false, spawnedAt: Date.now() });
  },
  killChild: async (id: string) => {
    const fake = fakes.get(id);
    if (fake) fake.killed = true;
  },
  unwatchChild: (id: string) => watchers.delete(id),
  watchChild: (id: string, line: (l: string) => void, exit: () => void) => watchers.set(id, { line, exit }),
  writeChild: async (id: string, line: string) => {
    const fake = fakes.get(id);
    if (!fake || fake.killed) throw new Error(`no child ${id}`);
    fake.written.push(line);
    fake.promptAt ??= Date.now();
    const message = JSON.parse(line) as { message: { content: { text: string }[] } };
    const prompt = message.message.content.map((c) => c.text).join("");
    const answer = script(prompt);
    // Like the CLI: init only once a prompt is in, then the stream, then the summary, then the result.
    setTimeout(() => {
      if (fake.killed) return;
      emit(id, { type: "system", subtype: "init" });
      setTimeout(() => {
        if (fake.killed) return;
        if (answer.fail) {
          emit(id, { type: "result", subtype: "error_during_execution", is_error: true, result: answer.fail });
          return;
        }
        emit(id, { type: "stream_event", event: { type: "message_start", message: { role: "assistant" } } });
        emit(id, { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
        emit(id, { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer.text } } });
        emit(id, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer.text }] } });
        emit(id, { type: "stream_event", event: { type: "content_block_stop", index: 0 } });
        emit(id, { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
        emit(id, { type: "stream_event", event: { type: "message_stop" } });
        setTimeout(() => {
          if (fake.killed) return;
          emit(id, { type: "system", subtype: "post_turn_summary" });
          emit(id, { type: "result", subtype: "success", is_error: false, result: answer.text });
        }, answer.summaryMs ?? 3_000);
      }, answer.thinkMs ?? 20);
    }, 5);
  },
}));

vi.mock("../../../../features/sessions/model/models", () => ({ modelsFor: () => [] }));

const text = await import("./claudeText");

beforeEach(() => {
  fakes.clear();
  watchers.clear();
  script = () => ({ text: "ok" });
});
afterEach(async () => {
  await text.stopClaudeTextPrompt();
});

it("writes the prompt as soon as the process is up: the CLI sends nothing before its first message", async () => {
  script = () => ({ text: '{"chime":[]}' });
  const started = Date.now();
  await expect(text.runClaudeTextPrompt({ cwd: "/p", prompt: "who else?" })).resolves.toBe('{"chime":[]}');
  const [fake] = fakes.values();
  expect(fake.promptAt! - fake.spawnedAt).toBeLessThan(200);
  expect(Date.now() - started).toBeLessThan(1_500);
});

it("answers when the model's message ends, not after the CLI's post-turn summary, and stops the process", async () => {
  script = () => ({ text: "A title", summaryMs: 4_000 });
  const started = Date.now();
  await expect(text.runClaudeTextPrompt({ cwd: "/p", prompt: "title this" })).resolves.toBe("A title");
  expect(Date.now() - started).toBeLessThan(1_500);
  expect([...fakes.values()].every((f) => f.killed)).toBe(true);
});

it("runs calls side by side: the room's gate never waits behind a slow chat title", async () => {
  script = (prompt) => (prompt.includes("title") ? { text: "Slow title", thinkMs: 2_500 } : { text: '{"chime":[]}' });
  const title = text.runClaudeTextPrompt({ cwd: "/p", prompt: "title this chat" });
  const started = Date.now();
  await expect(text.runClaudeTextPrompt({ cwd: "/p", prompt: "who else may speak?" })).resolves.toBe('{"chime":[]}');
  expect(Date.now() - started).toBeLessThan(1_500);
  await expect(title).resolves.toBe("Slow title");
  // Each call had its own process.
  expect(new Set([...fakes.values()].map((f) => f.id)).size).toBe(2);
});

it("isolated helper calls think only when asked (thinking cost seconds on a one-line JSON answer)", async () => {
  await text.runClaudeTextPrompt({ cwd: "/p", prompt: "x" });
  await text.runClaudeTextPrompt({ cwd: "/p", prompt: "y", modelSettings: { thinking: "true" } });
  const settings = [...fakes.values()].map((f) => JSON.parse(f.args[f.args.indexOf("--settings") + 1]) as Record<string, unknown>);
  expect(settings[0]).toMatchObject({ alwaysThinkingEnabled: false, disableAllHooks: true });
  expect(settings[1]).toMatchObject({ alwaysThinkingEnabled: true });
});

it("a failed turn, a timeout and a cancel each reject and leave no process behind", async () => {
  script = () => ({ text: "", fail: "Claude is overloaded" });
  await expect(text.runClaudeTextPrompt({ cwd: "/p", prompt: "x" })).rejects.toThrow();
  script = () => ({ text: "late", thinkMs: 5_000 });
  await expect(text.runClaudeTextPrompt({ cwd: "/p", prompt: "x", timeoutMs: 100 })).rejects.toThrow(/timed out/);
  const controller = new AbortController();
  const cancelled = text.runClaudeTextPrompt({ cwd: "/p", prompt: "x", signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await expect(cancelled).rejects.toThrow(/cancelled/);
  await vi.waitFor(() => expect([...fakes.values()].every((f) => f.killed)).toBe(true));
});
