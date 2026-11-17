// What a T3 thread does, said in this app's own words. T3 keeps a turn as "turn items" (a message, a thought, a
// command, a question) and sends each one again whenever it changes; the chat here wants harness events (a text
// delta, a tool that started, a question asked). `t3ItemEvents` turns one into the other and remembers, per turn, what
// it has already said about each item, so an update becomes only what is new.
import type { HarnessEvent } from "../../core/types";

/** A T3 turn item, as far as this app reads it (`OrchestrationV2TurnItem` in T3's contracts). Unknown types pass. */
export type T3Item = {
  id: string;
  type: string;
  status: string;
  /** The run it belongs to. */
  runId?: string | null;
  title?: string | null;
  text?: string;
  streaming?: boolean;
  input?: string;
  output?: string;
  fileName?: string;
  pattern?: string;
  patterns?: string[];
  steps?: Array<{ id: string; text: string; status: string }>;
  explanation?: string;
  message?: string;
  requestId?: string;
  requestKind?: string;
  /** An approval's question, or the brief a crew member was given. */
  prompt?: string;
  /** A crew member's latest word on how it is going, and what it reported at the end. */
  progress?: string;
  result?: string | null;
  /** The conversation of its own a crew member runs in, when the engine gave it one, and its node there. */
  childThreadId?: string | null;
  subagentId?: string;
  reason?: string;
  questions?: Array<{
    id: string;
    header?: string;
    question: string;
    multiSelect?: boolean;
    allowCustomAnswer?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
};

/** What the turn has already told the chat about one item. */
export type T3Seen = { text: number; started: boolean; done: boolean; progress?: string };

const DONE = new Set(["completed", "failed", "cancelled", "interrupted"]);
const CUT = new Set(["cancelled", "interrupted"]);

/** True once the item has stopped changing. */
export const t3ItemDone = (item: Pick<T3Item, "status">): boolean => DONE.has(item.status);

/** A crew member's name in the chat: its title, else the first line of its brief. */
export function t3CrewTitle(item: Pick<T3Item, "title" | "prompt">): string {
  const brief = (item.prompt ?? "").trim().split("\n", 1)[0];
  return item.title || (brief.length > 80 ? `${brief.slice(0, 79)}…` : brief) || "Crew member";
}

/** Everything in a thread before this turn: already on screen, so nothing about it is said again. */
export function markT3ItemSeen(item: T3Item, seen: Map<string, T3Seen>): void {
  seen.set(item.id, { text: (item.text ?? "").length, started: true, done: true });
}

/**
 * The harness events for one item as it stands now. `ask` gives T3's request id the number this app's question and
 * approval cards go by.
 */
export function t3ItemEvents(
  item: T3Item,
  seen: Map<string, T3Seen>,
  ask: (requestId: string) => number,
): HarnessEvent[] {
  const was = seen.get(item.id) ?? { text: 0, started: false, done: false };
  const now: T3Seen = { ...was };
  const out: HarnessEvent[] = [];
  const done = DONE.has(item.status);
  // A step cut short (its turn or its crew member was stopped) did not finish: the chat draws it as not done.
  const status = item.status === "failed" ? "failed" : CUT.has(item.status) ? "cancelled" : done ? "completed" : "in_progress";
  /** One row for the step. Its end is always said on its own, with what it printed, so the row stops running. */
  const tool = (title: string, kind: string, extra: { command?: string; paths?: string[] } = {}, detail?: string) => {
    if (!was.started) out.push({ type: "tool.started", callId: item.id, title, kind, status, ...extra });
    if (done && !was.done) out.push({ type: "tool.updated", callId: item.id, status, ...(detail ? { detail } : {}) });
    now.started = true;
  };

  switch (item.type) {
    case "assistant_message":
    case "reasoning": {
      const text = item.text ?? "";
      const reasoning = item.type === "reasoning";
      if (text.length > was.text)
        out.push({ type: reasoning ? "reasoning.delta" : "message.delta", text: text.slice(was.text) });
      now.text = Math.max(was.text, text.length);
      if ((done || item.streaming === false) && !was.done && text.length > 0) {
        out.push({ type: reasoning ? "reasoning.completed" : "message.completed" });
        now.done = true;
      }
      seen.set(item.id, now);
      return out;
    }
    case "command_execution":
      tool(item.input || "Command", "execute", item.input ? { command: item.input } : {}, item.output || undefined);
      break;
    case "file_change":
      tool(`Edit ${item.fileName ?? "file"}`, "edit", item.fileName ? { paths: [item.fileName] } : {});
      break;
    case "file_search":
      tool(item.pattern ? `Search ${item.pattern}` : "Search files", "search");
      break;
    case "web_search":
      tool(item.patterns?.length ? `Search the web: ${item.patterns.join(", ")}` : "Search the web", "fetch");
      break;
    case "subagent": {
      // A crew member the agent started: one row in the chat, its progress and its report as that row's own trail.
      tool(t3CrewTitle(item), "agent");
      if (!done && item.progress && item.progress !== was.progress) {
        out.push({
          type: "agent.step",
          callId: item.id,
          stepId: `${item.id}:progress`,
          kind: "tool",
          text: item.progress,
          status: "in_progress",
        });
        now.progress = item.progress;
      }
      if (done && !was.done && item.result?.trim())
        out.push({ type: "agent.step", callId: item.id, stepId: `${item.id}:report`, kind: "message", text: item.result });
      break;
    }
    case "dynamic_tool":
      tool(item.title || "Tool", "other");
      break;
    case "todo_list":
      out.push({
        type: "tasks.updated",
        key: "t3-plan",
        authoritative: true,
        ...(item.explanation ? { explanation: item.explanation } : {}),
        items: (item.steps ?? []).map((step) => ({
          id: step.id,
          text: step.text,
          status: step.status === "running" ? "in_progress" : step.status === "completed" ? "completed" : "pending",
        })),
      });
      break;
    case "user_input_request": {
      if (!item.requestId) break;
      const requestId = ask(item.requestId);
      if (!was.started && !done)
        out.push({
          type: "question.asked",
          requestId,
          callId: item.id,
          questions: (item.questions ?? []).map((question) => ({
            id: question.id,
            ...(question.header ? { header: question.header } : {}),
            prompt: question.question,
            multiSelect: question.multiSelect === true,
            allowCustom: question.allowCustomAnswer !== false,
            options: question.options.map((option) => ({
              id: option.label,
              label: option.label,
              ...(option.description && option.description !== option.label ? { description: option.description } : {}),
            })),
          })),
        });
      else if (done && !was.done) out.push({ type: "question.resolved", requestId, decision: "answered" });
      now.started = true;
      break;
    }
    case "approval_request": {
      if (!item.requestId) break;
      const requestId = ask(item.requestId);
      if (!was.started && !done)
        out.push({
          type: "approval.requested",
          requestId,
          callId: item.id,
          title: item.prompt || item.reason || item.requestKind || "Approval",
          ...(item.requestKind ? { kind: item.requestKind } : {}),
        });
      else if (done && !was.done)
        out.push({ type: "approval.resolved", requestId, decision: item.status === "completed" ? "allow" : "cancelled" });
      now.started = true;
      break;
    }
    case "system_notice":
      if (!was.started && item.message) out.push({ type: "notice", text: item.message });
      now.started = true;
      break;
    case "error":
      if (!was.started) out.push({ type: "session.error", message: item.message || "The engine reported an error." });
      now.started = true;
      break;
    default:
      break;
  }
  if (done) now.done = true;
  seen.set(item.id, now);
  return out;
}
