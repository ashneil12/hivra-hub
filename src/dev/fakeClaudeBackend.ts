// Dev only (hub-dev.html?fakeClaude): a stand-in for the Claude Code CLI behind the real Claude adapter, so a browser
// test drives the real app (composer, Today, the Monos rail, Being built) through a question, an API failure and a
// reply, with no login and no tokens. It speaks the stream-json the adapter speaks to the CLI; the 402 and 529 are the
// CLI's own recorded output (providers/claude/fixtures/claude-cli-2.1.302). The test says what the next prompt gets:
// `window.__fakeClaude.next.push("ask" | "402" | "529" | "hold" | "reply" | "say:<text>")` (an empty list replies), and reads what the
// app answered the questions with in `window.__fakeClaude.answers`. Never shipped: only hub-dev.html loads it.
import type { ChildBackend } from "../integrations/harness/core/child";
import fixture402 from "../integrations/harness/providers/claude/fixtures/claude-cli-2.1.302/402-billing.ndjson?raw";
import fixture529 from "../integrations/harness/providers/claude/fixtures/claude-cli-2.1.302/529-overloaded.ndjson?raw";

export type FakeClaudeState = {
  next: string[];
  /** Every prompt as the CLI got it on stdin: its text, and the message's content blocks as sent (images, files). */
  prompts: Array<{ sessionId: string; text: string; content?: unknown }>;
  answers: Array<{ sessionId: string; behavior: string; answers: Record<string, string> | null }>;
  /** Ends every turn held by "hold". */
  release(): void;
  /** What the app asked of the CLI to stop a turn: control requests (`interrupt`, `stop_task`) and kills, by chat. */
  stops: Array<{ sessionId: string; kind: string }>;
};

type Handler = (event: { payload: unknown }) => void;

const RECORDED: Record<string, string> = { "402": fixture402, "529": fixture529 };

export function fakeClaudeBackend(): ChildBackend {
  const handlers = new Map<string, Handler>();
  const conversations = new Map<string, string>();
  /** The app's own helper calls (a title, a room pick: `--no-session-persistence`) get a plain answer, not the script. */
  const helpers = new Set<string>();
  const waiting = new Map<string, (response: Record<string, unknown>) => void>();
  const held: Array<() => void> = [];
  let counter = 0;
  const state: FakeClaudeState = {
    next: [],
    prompts: [],
    answers: [],
    release: () => held.splice(0).forEach((done) => done()),
    stops: [],
  };
  (window as unknown as { __fakeClaude: FakeClaudeState }).__fakeClaude = state;

  const emit = (sessionId: string, record: Record<string, unknown>) =>
    handlers.get("harness-stdout")?.({ payload: { sessionId, lines: [JSON.stringify(record)] } });
  const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const conversation = (sessionId: string) => conversations.get(sessionId) ?? sessionId;
  const assistant = (sessionId: string, content: unknown[]) =>
    emit(sessionId, {
      type: "assistant",
      session_id: conversation(sessionId),
      parent_tool_use_id: null,
      message: { id: `msg_fake_${(counter += 1)}`, type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason: null },
    });
  const result = (sessionId: string, text: string) =>
    emit(sessionId, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      session_id: conversation(sessionId),
      duration_ms: 400,
      duration_api_ms: 380,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  const say = (sessionId: string, text: string) => {
    assistant(sessionId, [{ type: "text", text }]);
    result(sessionId, text);
  };

  async function play(sessionId: string, prompt: string) {
    if (helpers.has(sessionId)) {
      await later(60);
      return say(sessionId, JSON.stringify({ title: "Chat", workItem: null }));
    }
    const what = state.next.shift() ?? "reply";
    await later(120);
    emit(sessionId, { type: "system", subtype: "init", session_id: conversation(sessionId), model: "claude-sonnet-5", tools: [] });
    if (RECORDED[what]) {
      for (const line of RECORDED[what].split("\n").filter((l) => l.trim())) {
        const record = JSON.parse(line) as Record<string, unknown>;
        record.session_id = conversation(sessionId);
        emit(sessionId, record);
        await later(30);
      }
      return;
    }
    if (what.startsWith("say:")) return say(sessionId, what.slice(4));
    if (what === "hold") {
      assistant(sessionId, [{ type: "text", text: "On it." }]);
      await new Promise<void>((resolve) => held.push(resolve));
      return result(sessionId, "Done.");
    }
    if (what === "ask") {
      assistant(sessionId, [{ type: "text", text: "The README says sharing is your call, so one question first." }]);
      const toolId = `toolu_fake_${(counter += 1)}`;
      const input = {
        questions: [
          {
            question: "Which sharing model should Tally build?",
            header: "Sharing",
            multiSelect: false,
            options: [
              { label: "Private unless shared (Recommended)", description: "Only the owner sees a tally until they share it." },
              { label: "Everyone sees everything", description: "Every tally is public to the team." },
            ],
          },
        ],
      };
      assistant(sessionId, [{ type: "tool_use", id: toolId, name: "AskUserQuestion", input }]);
      const requestId = `fake-ask-${counter}`;
      const response = await new Promise<Record<string, unknown>>((resolve) => {
        waiting.set(requestId, resolve);
        emit(sessionId, { type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input, tool_use_id: toolId } });
      });
      const allowed = response.behavior === "allow";
      const answers = allowed ? ((response.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ?? {}) : null;
      state.answers.push({ sessionId, behavior: String(response.behavior), answers });
      emit(sessionId, {
        type: "user",
        session_id: conversation(sessionId),
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolId,
              content: allowed
                ? `User has answered your questions: ${Object.entries(answers ?? {}).map(([q, a]) => `"${q}"="${a}"`).join(", ")}. You can now continue with the user's answers in mind.`
                : String(response.message ?? "User declined to answer questions"),
              is_error: !allowed,
            },
          ],
        },
      });
      await later(150);
      return say(sessionId, allowed ? `Going with your answer: ${Object.values(answers ?? {}).join("; ")}. Building it now.` : "Understood, I won't ask that.");
    }
    // The design mockup (src/dev/mockup) answers in its own words.
    const custom = (window as unknown as { __fakeClaudeReply?: (prompt: string) => string | undefined }).__fakeClaudeReply?.(prompt);
    if (custom) return say(sessionId, custom);
    return say(sessionId, prompt.includes("Continue from where you left off") ? "Picked up where I left off: all green." : "All green: 14 tests pass.");
  }

  return {
    async listen(event, handler) {
      handlers.set(event, handler as Handler);
      return () => handlers.delete(event);
    },
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      switch (command) {
        case "harness_resolve_claude":
        case "harness_resolve_configured":
          return { path: "/fake/claude" } as T;
        case "harness_spawn": {
          const list = (args?.args as string[] | undefined) ?? [];
          const named = (flag: string) => (list.indexOf(flag) >= 0 ? list[list.indexOf(flag) + 1] : undefined);
          const id = named("--resume") ?? named("--session-id");
          if (id && args?.sessionId) conversations.set(String(args.sessionId), id);
          if (list.includes("--no-session-persistence") && args?.sessionId) helpers.add(String(args.sessionId));
          return (4000 + (counter += 1)) as T;
        }
        case "harness_write": {
          const sessionId = String(args?.sessionId);
          const record = JSON.parse(String(args?.line)) as Record<string, unknown>;
          const request = record.request as { subtype?: string } | undefined;
          if (record.type === "control_request") {
            if (request?.subtype === "interrupt" || request?.subtype === "stop_task") {
              state.stops.push({ sessionId, kind: request.subtype });
              // As the CLI does: an interrupt ends the running turn.
              if (request.subtype === "interrupt") state.release();
            }
            if (request?.subtype !== "interrupt" && request?.subtype !== "stop_task")
              setTimeout(() => emit(sessionId, { type: "control_response", response: { subtype: "success", request_id: record.request_id, response: {} } }), 10);
          } else if (record.type === "control_response") {
            const response = record.response as { request_id?: string; response?: Record<string, unknown> } | undefined;
            const done = response?.request_id ? waiting.get(response.request_id) : undefined;
            if (done && response?.request_id) {
              waiting.delete(response.request_id);
              done(response.response ?? {});
            }
          } else if (record.type === "user") {
            if (helpers.has(sessionId)) {
              void play(sessionId, "");
              return undefined as T;
            }
            const content = (record.message as { content?: unknown } | undefined)?.content;
            const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("\n") : "";
            state.prompts.push({ sessionId, text, content });
            void play(sessionId, text);
          }
          return undefined as T;
        }
        case "harness_kill":
        case "harness_kill_all":
          state.stops.push({ sessionId: String(args?.sessionId ?? "*"), kind: command });
          return undefined as T;
        default:
          return null as T;
      }
    },
  };
}
