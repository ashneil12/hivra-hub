import { modelsFor } from "../../../../features/sessions/model/models";
import {
  killChild,
  resolveClaudeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
  writeChild,
} from "../../core/child";
import { CREDENTIAL_DENY_RULES } from "../../core/credentialGuard";
import { isAgentToolName } from "../../core/preview";
import {
  assistantTextBlocks,
  buildClaudeSpawnArgs,
  buildClaudeUserMessage,
  inputJsonDeltaFromEvent,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  parseJsonLine,
  previewFromTool,
  resolveClaudeApiModelId,
  SIDE_QUESTION_DENY_TOOLS,
  SIDE_QUESTION_TOOLS,
  streamDeltaFromEvent,
  stringField,
  summarizeToolRequest,
  toolKindFromName,
  toolStartFromEvent,
  toolTitle,
  tryParseJsonRecord,
  turnStatusFromResult,
} from "./claudeProtocol";
import type { TurnIntent } from "../../../../features/sessions/model/session";
import type { HarnessEvent } from "../../core/types";
import { mergeStream } from "../../core/streamText";
import { claudeGuardArgs } from "./claudeExtraArgs";

// MonoCode's own small calls to Claude (chat titles, commit and PR text, the room's chime gate, "by the way"
// questions): one isolated CLI process per call, closed as soon as its answer is in. Measured on 20 Oct (docs/REALTEST.md):
// the CLI sends nothing before it has a prompt, so waiting for a "ready" line cost 8 s on every call; the post-turn
// summary it writes after the answer cost about 3 s more; one call at a time put the room's gate behind chat titles;
// and the default thinking on a one-line JSON answer cost seconds. So: the prompt goes in at once, the answer counts
// when the model's message ends, calls run side by side, and a helper call (no model asked for) doesn't think unless
// asked to.
const TEXT_CHILD_PREFIX = "monocode-claude-text";
const REQUEST_TIMEOUT_MS = 45_000;
const TEXT_MODEL = "claude-haiku-4-5";

type TextSettings = {
  launchModel: string;
  effort?: string;
  promptEffort?: string;
  settings: Record<string, boolean>;
  permissionMode?: "plan";
  maxTurns?: number;
};

type InFlightTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
  title: string;
};

/** One call: its own process, its answer as it streams, and how it ends. */
type TextCall = {
  id: string;
  output: string;
  closed: boolean;
  done: (() => void) | null;
  failed: ((error: Error) => void) | null;
  onEvent?: (event: HarnessEvent) => void;
  toolsByIndex: Map<number, InFlightTool>;
  toolsById: Map<string, InFlightTool>;
};

const calls = new Map<string, TextCall>();
let callSeq = 0;

function textSettings(
  model: string,
  helper: boolean,
  modelSettings?: Record<string, string>,
  intent?: TurnIntent,
): TextSettings {
  const effort = modelSettings?.effort?.trim() || undefined;
  const context = modelSettings?.context?.trim() || undefined;
  const thinking = modelSettings?.thinking;
  const fast = modelSettings?.fast === "true";
  const readOnly = intent === "plan";
  const settings: Record<string, boolean> = {};
  if (thinking === "true") settings.alwaysThinkingEnabled = true;
  // The small model thinks by default; a title or a JSON pick doesn't need it.
  else if (thinking === "false" || helper) settings.alwaysThinkingEnabled = false;
  if (fast) settings.fastMode = true;
  if (isClaudeUltracodeEffort(effort)) settings.ultracode = true;
  return {
    launchModel: resolveClaudeApiModelId(model, context),
    effort: normalizeClaudeCliEffort(effort, model),
    promptEffort: effort,
    settings,
    ...(readOnly ? { permissionMode: "plan" as const, maxTurns: 1 } : {}),
  };
}

/**
 * The model for a call: the one asked for, else the newest versioned Haiku the CLI offers. Never the bare "haiku"
 * alias: measured 20 Oct (CLI 2.1.304), with --permission-mode plan the CLI ran it on Sonnet 5.5, and without plan mode
 * it thought before a one-line answer even with thinking off; a versioned id answers in 2 to 3 s.
 */
function pickTextModel(requested?: string): string {
  const selected = requested?.trim();
  if (selected) return selected;
  const versioned = modelsFor("claude")
    .map((model) => model.nativeId ?? "")
    .map((id) => ({ id, version: /^claude-haiku-(\d+)-(\d+)$/.exec(id) }))
    .filter((m): m is { id: string; version: RegExpExecArray } => !!m.version)
    .sort((a, b) => Number(b.version[1]) - Number(a.version[1]) || Number(b.version[2]) - Number(a.version[2]));
  return versioned[0]?.id ?? TEXT_MODEL;
}

/**
 * `args` with `tools` added to its last `--disallowedTools` list, so one deny list never replaces another. With no list
 * to add to (the hub has registered no fence) the new one also names the saved-login rules the spawn already carries,
 * so it holds on its own whether the CLI joins repeated lists or keeps the last.
 */
function withDeniedTools(args: readonly string[], tools: readonly string[]): string[] {
  const at = args.lastIndexOf("--disallowedTools");
  if (at < 0 || at + 1 >= args.length) return [...args, "--disallowedTools", [...CREDENTIAL_DENY_RULES, ...tools].join(",")];
  const next = [...args];
  next[at + 1] = [args[at + 1], ...tools].filter(Boolean).join(",");
  return next;
}

/**
 * A call that only wants text back (a title, commit or PR text, a branch name, the room's gate: everything it needs is
 * in the prompt) starts with no tools at all. One whose answer streams into a chat ("by the way") is limited to the
 * read tools (`--tools`, SIDE_QUESTION_TOOLS) with the ones that change things denied behind that
 * (SIDE_QUESTION_DENY_TOOLS), the way the checker's tool list is built (hubMcp.ts checkerToolArgs). Both carry the
 * hub's fence round the Monos' home, as every Claude process the app starts does.
 */
export function textCallToolArgs(streams: boolean): string[] {
  const guard = claudeGuardArgs();
  return streams
    ? ["--tools", SIDE_QUESTION_TOOLS.join(","), ...withDeniedTools(guard, SIDE_QUESTION_DENY_TOOLS)]
    : ["--tools", "", ...guard];
}

/** Stop every call still running (the app is closing, or the helpers are being reset). */
export async function stopClaudeTextPrompt(): Promise<void> {
  await Promise.all(
    [...calls.values()].map((call) => {
      call.failed?.(new Error("Claude text generator stopped"));
      return closeCall(call);
    }),
  );
}

/** Nothing to keep warm: each call starts its own process and writes its prompt at once. Finds the CLI ahead. */
export async function warmupClaudeText(cwd: string): Promise<void> {
  if (!cwd || cwd === "~") return;
  await resolveClaudeBinary().catch(() => undefined);
}

export async function runClaudeTextPrompt(input: {
  cwd: string;
  providerAccountId?: string;
  model?: string;
  modelSettings?: Record<string, string>;
  intent?: TurnIntent;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const model = pickTextModel(input.model);
  const settings = textSettings(model, !input.model?.trim(), input.modelSettings, input.intent);
  const { path } = await resolveClaudeBinary();
  input.signal?.throwIfAborted();
  const call: TextCall = {
    id: `${TEXT_CHILD_PREFIX}-${++callSeq}`,
    output: "",
    closed: false,
    done: null,
    failed: null,
    onEvent: input.onEvent,
    toolsByIndex: new Map(),
    toolsById: new Map(),
  };
  calls.set(call.id, call);
  const finished = new Promise<void>((resolve, reject) => {
    call.done = resolve;
    call.failed = reject;
  });
  // A call that fails before anyone waits on it must not count as unhandled.
  finished.catch(() => undefined);
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    watchChild(
      call.id,
      (line) => handleLine(call, line),
      () => {
        call.closed = true;
        call.failed?.(new Error("Claude text generator exited"));
      },
    );
    await spawnChild(
      call.id,
      path,
      [
        ...buildClaudeSpawnArgs({
          isolated: true,
          model: settings.launchModel,
          effort: settings.effort,
          settings: settings.settings,
          permissionMode: settings.permissionMode,
          maxTurns: settings.maxTurns,
        }),
        ...textCallToolArgs(!!input.onEvent),
      ],
      input.cwd,
      { provider: "claude", id: input.providerAccountId ?? "default" },
      "claude",
    );
    // The CLI reads its prompt once it is up and only then says anything: never wait for it first.
    await writeChild(
      call.id,
      JSON.stringify(
        buildClaudeUserMessage({
          text: input.prompt,
          effort: settings.promptEffort,
        }),
      ),
    );
    await Promise.race([
      finished,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude text generation timed out")),
          timeoutMs,
        );
      }),
      ...(input.signal
        ? [
            new Promise<never>((_, reject) => {
              abortHandler = () => reject(new Error("By-the-way request cancelled"));
              input.signal!.addEventListener("abort", abortHandler, { once: true });
              if (input.signal!.aborted) abortHandler();
            }),
          ]
        : []),
    ]);
    const output = call.output.trim();
    if (!output) throw new Error("Claude returned empty output.");
    return output;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler && input.signal) {
      input.signal.removeEventListener("abort", abortHandler);
    }
    await closeCall(call);
  }
}

async function closeCall(call: TextCall): Promise<void> {
  calls.delete(call.id);
  call.closed = true;
  call.done = null;
  call.failed = null;
  unwatchChild(call.id);
  await killChild(call.id).catch(() => undefined);
}

function finish(call: TextCall, error?: Error): void {
  if (error) call.failed?.(error);
  else call.done?.();
  call.done = null;
  call.failed = null;
}

function handleLine(call: TextCall, line: string): void {
  if (call.closed) return;
  const rec = parseJsonLine(line);
  if (!rec) return;
  const type = stringField(rec, "type");
  if (type === "assistant") {
    const snapshot = assistantTextBlocks(rec).join("");
    if (snapshot) call.output = mergeStream(call.output, snapshot);
    return;
  }
  if (type === "stream_event") {
    handleStreamEvent(call, rec);
    return;
  }
  if (type === "result") {
    const result = turnStatusFromResult(rec);
    finish(call, result.status === "failed" ? new Error(result.error ?? "Claude turn failed") : undefined);
  }
}

function handleStreamEvent(
  session: TextCall,
  rec: Record<string, unknown>,
): void {
  // The model's message is over: its text is all in. The CLI's post-turn summary and result come seconds later.
  // (A subagent's own messages carry their parent tool call and don't end the turn.)
  const event = rec.event as { type?: unknown; delta?: { stop_reason?: unknown } } | undefined;
  const stop = event?.type === "message_delta" ? event.delta?.stop_reason : undefined;
  if (!rec.parent_tool_use_id && (stop === "end_turn" || stop === "stop_sequence")) {
    finish(session);
    return;
  }
  const delta = streamDeltaFromEvent(rec);
  if (delta) {
    if (delta.kind === "assistant") {
      session.output = mergeStream(session.output, delta.text);
      session.onEvent?.({ type: "message.delta", text: delta.text });
    } else {
      session.onEvent?.({ type: "reasoning.delta", text: delta.text });
    }
    return;
  }

  const started = toolStartFromEvent(rec);
  if (started) {
    const tool: InFlightTool = {
      id: started.id,
      name: started.name,
      input: started.input,
      partialJson: "",
      title: toolTitle(started.name, started.input),
    };
    if (started.index >= 0) session.toolsByIndex.set(started.index, tool);
    session.toolsById.set(started.id, tool);
    session.onEvent?.({
      type: "tool.started",
      callId: tool.id,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      ...(isAgentToolName(tool.name) && stringField(tool.input, "model")
        ? { agentModel: stringField(tool.input, "model") }
        : {}),
      status: isAgentToolName(tool.name) ? "in_progress" : "pending",
      preview: previewFromTool(tool.name, tool.input),
    });
    return;
  }

  const jsonDelta = inputJsonDeltaFromEvent(rec);
  if (!jsonDelta) return;
  const tool = session.toolsByIndex.get(jsonDelta.index);
  if (!tool) return;
  tool.partialJson += jsonDelta.partial;
  const parsed = tryParseJsonRecord(tool.partialJson);
  if (!parsed) return;
  tool.input = parsed;
  tool.title = toolTitle(tool.name, parsed);
  session.onEvent?.({
    type: "tool.updated",
    callId: tool.id,
    title: tool.title,
    kind: toolKindFromName(tool.name),
    ...(isAgentToolName(tool.name) && stringField(tool.input, "model")
      ? { agentModel: stringField(tool.input, "model") }
      : {}),
    status: "pending",
    detail: summarizeToolRequest(tool.name, parsed),
    preview: previewFromTool(tool.name, parsed),
  });
}
