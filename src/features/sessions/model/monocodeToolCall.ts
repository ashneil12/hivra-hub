import type { Block } from "./session";

export type MonoCodeToolCall = {
  action: string;
  label: string;
  command: string;
  /** One of the delegate tool's MCP tools (mcp__monocode__* or monocode:*), not an app CLI command. */
  delegate?: DelegateToolName;
};

/**
 * The delegate tool's tools (src-tauri/src/mcp_server.rs), as Claude Code names them: mcp__monocode__<tool>. A Codex
 * lead names the same calls monocode:<tool> (its mcpToolCall item joins the server and the tool with a colon).
 */
export type DelegateToolName =
  | "delegate_task"
  // Hivra WP-171: the multi-part form of delegate_task.
  | "delegate_tasks"
  | "task_status"
  | "task_wait"
  | "task_cancel"
  | "task_cannot"
  | "task_answer"
  | "task_accept"
  // Hivra WP-14.
  | "task_message"
  | "ask_person";

/**
 * T3's verb table (packages/shared/src/t3McpToolPresentation.ts, MIT): what the tool does, while it runs, once it is
 * done, and its object. Distinct ids are counted for the tools that act on one task each.
 */
const DELEGATE_TOOLS: Record<
  DelegateToolName,
  {
    labels: readonly [string, string, string, string];
    /** The noun counted across a group of calls, and the id that makes two calls the same one. */
    count?: { noun: string; id: (output: Record<string, unknown>) => unknown };
  }
> = {
  delegate_task: {
    labels: ["Delegate", "Delegating", "Delegated", "a task"],
    count: { noun: "task", id: (output) => output.taskId },
  },
  delegate_tasks: {
    labels: ["Delegate", "Delegating", "Delegated", "a multi-part ask"],
    // One call hands out several tasks: counted by the worker chats its result names.
    count: { noun: "task", id: (output) => output.childSessionId },
  },
  task_status: { labels: ["Check", "Checking", "Checked", "task status"] },
  task_wait: { labels: ["Wait for", "Waiting for", "Waited for", "tasks"] },
  task_cancel: {
    labels: ["Stop", "Stopping", "Stopped", "a task"],
    count: { noun: "task", id: (output) => output.taskId },
  },
  task_cannot: {
    labels: ["Say", "Saying", "Said", "a task cannot finish"],
    count: { noun: "task", id: (output) => output.taskId },
  },
  task_answer: {
    labels: ["Answer", "Answering", "Answered", "a worker's question"],
    count: { noun: "worker's question", id: (output) => output.taskId },
  },
  task_accept: {
    labels: ["Accept", "Accepting", "Accepted", "a finished task"],
    count: { noun: "task", id: (output) => output.taskId },
  },
  task_message: {
    labels: ["Message", "Messaging", "Messaged", "a worker"],
    count: { noun: "message", id: (output) => output.messageId },
  },
  ask_person: {
    labels: ["Ask", "Asking", "Asked", "you a decision"],
    count: { noun: "decision", id: (output) => output.key },
  },
};

const DELEGATE_TOOL_NAME = /^(?:mcp__monocode__|monocode:)([a-z_]+)$/;

/** Which delegate tool a tool block called, if it is one. */
export function delegateToolName(block: Block): DelegateToolName | undefined {
  if (block.role !== "tool" && block.role !== "approval") return undefined;
  for (const candidate of [block.tool?.kind, block.tool?.title, block.text]) {
    const name = candidate?.trim().match(DELEGATE_TOOL_NAME)?.[1];
    if (name && Object.prototype.hasOwnProperty.call(DELEGATE_TOOLS, name))
      return name as DelegateToolName;
  }
  return undefined;
}

/** A call that hands work to workers: delegate_task, or its multi-part form delegate_tasks (WP-171). */
export function handsOutWork(block: Block): boolean {
  const name = delegateToolName(block);
  return name === "delegate_task" || name === "delegate_tasks";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A tool's input or result, read from JSON text (an MCP result may wrap its text in content blocks). */
export function delegateToolData(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    try {
      return delegateToolData(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = record(entry)?.text;
      const data =
        text !== undefined ? delegateToolData(text, depth + 1) : undefined;
      if (data) return data;
    }
    return undefined;
  }
  const data = record(value);
  if (!data) return undefined;
  const content = data.structuredContent ?? data.content;
  if (content !== undefined && !("taskId" in data) && !("tasks" in data))
    return delegateToolData(content, depth + 1) ?? data;
  return data;
}

/** T3's rule: an MCP error can come back as data even when the call itself completed. */
export function delegateToolFailed(block: Block): boolean {
  const status = block.tool?.status?.toLowerCase() ?? "";
  if (["failed", "error", "cancelled", "canceled"].includes(status))
    return true;
  if (block.approval?.decided === "deny") return true;
  const output = record(
    (() => {
      try {
        return JSON.parse(block.tool?.detail ?? "");
      } catch {
        return undefined;
      }
    })(),
  );
  return (
    !!output &&
    (output.isError === true ||
      output.is_error === true ||
      (output.error !== undefined && output.error !== null))
  );
}

function delegateToolDone(block: Block): boolean {
  const status = block.tool?.status?.toLowerCase() ?? "";
  return (
    status === "completed" ||
    status === "success" ||
    (!status && !block.streaming)
  );
}

const MAX_JOB = 60;

/**
 * r97 item 3: the job a delegate_task call handed out, from its result's title (the input isn't kept once the call is
 * done), as a goal: the row reads "Asked a worker to: Fix the save bug". Never a result: anything from a "Done when" on
 * and any claim that something passed or is done is cut (r96, c02 6968: "Done when: … npm test passed" read as done).
 */
export function delegateJobName(block: Block): string | undefined {
  const raw = delegateToolData(block.tool?.detail)?.title;
  if (typeof raw !== "string") return undefined;
  let job = raw.split("\n")[0]!.replace(/\s+/g, " ").trim();
  job = job.replace(/\s*(?:[-–—:;,.]\s*)?\bdone when\b.*$/i, "").trim();
  if (/\b(?:passed|passes|pass(?:ing)?|green|is done|are done|done|fixed|landed|works now)\s*[.!]?$/i.test(job)) return undefined;
  job = job.replace(/[.:;,\s]+$/, "");
  if (!job) return undefined;
  return job.length > MAX_JOB ? `${job.slice(0, MAX_JOB - 1).trimEnd()}…` : job;
}

/** One delegate tool call as its row reads: "Delegating a task", "Delegated a task", "Tried to delegate a task". */
export function delegateToolLabel(
  block: Block,
  name: DelegateToolName,
): string {
  const [action, running, done, object] = DELEGATE_TOOLS[name].labels;
  if (delegateToolFailed(block))
    return `Tried to ${action.toLowerCase()} ${object}`;
  if (name === "delegate_task") {
    const job = delegateJobName(block);
    if (job) return `Asked a worker to: ${job}`;
  }
  if (name === "delegate_tasks" && delegateToolDone(block)) {
    const handed = fanoutSessions(block).length;
    if (handed) return `Handed out ${quantity(handed, "task")}`;
  }
  return `${delegateToolDone(block) ? done : running} ${object}`;
}

/**
 * WP-171: the worker chats one delegate_tasks call handed out (started or waiting for what they need), from its result.
 * A task the app refused names no chat, so it is not counted.
 */
export function fanoutSessions(block: Block): string[] {
  const tasks = delegateToolData(block.tool?.detail)?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((task) => {
    const id = record(task)?.childSessionId;
    return typeof id === "string" && id ? [id] : [];
  });
}

function quantity(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * A group of calls to one delegate tool, summed up as T3 does: "Delegated 3 tasks", "Checked task status 2 times",
 * "Tried to delegate 1 task" when every call failed. Distinct ids are counted, so a retried call counts once.
 */
export function delegateToolsSummary(
  steps: Block[],
  live: boolean,
): string | undefined {
  const names = steps.map(delegateToolName);
  const name = names[0];
  if (!name || names.some((entry) => entry !== name)) return undefined;
  const definition = DELEGATE_TOOLS[name];
  const [action, running, done, object] = definition.labels;
  const completed = steps.filter((step) => !delegateToolFailed(step));
  const selected = completed.length ? completed : steps;
  const verb = !completed.length
    ? `Tried to ${action.toLowerCase()}`
    : live && completed.some((step) => !delegateToolDone(step))
      ? running
      : done;
  if (!definition.count) {
    const times = selected.length;
    return `${verb} ${object}${times > 1 ? ` ${times} times` : ""}`;
  }
  // A call's result names its task (the input isn't kept once the call is done).
  const ids = selected.flatMap((step) => {
    if (name === "delegate_tasks") {
      const handed = fanoutSessions(step);
      return handed.length ? handed : [undefined];
    }
    const id = definition.count!.id(delegateToolData(step.tool?.detail) ?? {});
    return [typeof id === "string" && id ? id : undefined];
  });
  const count =
    new Set(ids.filter((id) => id !== undefined)).size +
    ids.filter((id) => id === undefined).length;
  return `${verb} ${quantity(count, definition.count.noun)}`;
}

const ACTION_LABELS: Record<string, string> = {
  "app.version": "Check the app version",
  "models.list": "List models",
  "sessions.list": "List sessions",
  "sessions.read": "Read a session",
  "sessions.send": "Continue a session",
  "sessions.draft": "Save a draft",
  "sessions.start": "Start a session",
  "sessions.stop": "Stop a session",
  "sessions.archive": "Archive a session",
  "sessions.delete": "Delete a session",
  "folders.list": "List folders",
  "folders.move": "Move a session",
  "notes.list": "List notes",
  "notes.read": "Read a note",
  "notes.write": "Write a note",
  "docs.list": "List pages",
  "docs.get": "Read a page",
  "docs.create": "Create a page",
  "docs.update": "Update a page",
  "artifacts.list": "List artifacts",
  "artifacts.read": "Read an artifact",
  "artifacts.write": "Write an artifact",
};

/** Conservatively parse one shell invocation; compound commands use the shell row. */
function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === "'" && !quote) {
      quote = "'";
      started = true;
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"';
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (!next) return undefined;
      // Preserve ordinary path separators, including quoted Windows paths.
      if (
        (quote === '"' && !/[\\"$`]/.test(next)) ||
        (!quote && !/[\s'"\\;&|<>()[\]{}$`#]/.test(next))
      ) {
        word += char;
      } else {
        word += next;
        index += 1;
      }
      started = true;
      continue;
    }
    if (char === "$" || char === "`") return undefined;
    if (!quote && /[\r\n;&|<>()[\]{}#]/.test(char)) return undefined;
    if (!quote && /\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

/** Recognize the actual app CLI command, not a mention of it in prose/output. */
export function monoCodeToolCall(block: Block): MonoCodeToolCall | undefined {
  if (block.role !== "tool" && block.role !== "approval") return undefined;
  const delegate = delegateToolName(block);
  if (delegate) {
    const [action, , , object] = DELEGATE_TOOLS[delegate].labels;
    return {
      action: delegate,
      label: `${action} ${object}`,
      command: `mcp__monocode__${delegate}`,
      delegate,
    };
  }
  // A shell preview retains the original command when the display title was
  // simplified. Never accept a shorter title in place of that command.
  const candidate =
    (block.tool?.preview?.kind === "shell"
      ? block.tool.preview.title
      : undefined) ??
    block.tool?.title ??
    block.text;
  const command = candidate?.trim().replace(/^Run(?:ning)?\s+command:\s*/i, "");
  if (!command) return undefined;
  const words = shellWords(command);
  if (!words || !/(?:^|[/\\])monocode(?:\.exe)?$/i.test(words[0] ?? ""))
    return undefined;
  if (words[1] !== "app") return undefined;
  const action = words[2] ?? "--help";
  if (action === "--help" || action === "help" || action === "-h") {
    return words.length > 3
      ? undefined
      : { action: "--help", label: "View CLI commands", command };
  }
  if (!Object.prototype.hasOwnProperty.call(ACTION_LABELS, action))
    return undefined;
  for (let index = 3; index < words.length; index += 2) {
    if (
      !["--json", "--input", "--request-id"].includes(words[index]) ||
      !words[index + 1]
    )
      return undefined;
  }
  return { action, label: ACTION_LABELS[action], command };
}

/** A group of only MonoCode calls can be named for the app, not the shell. */
export function monoCodeWorkSummary(
  steps: Block[],
  live: boolean,
): string | undefined {
  if (steps.some((block) => block.interjection || block.role === "system")) {
    return undefined;
  }
  const calls = steps.filter(
    (block) => block.role === "tool" || block.role === "approval",
  );
  if (calls.length === 0 || calls.some((block) => !monoCodeToolCall(block))) {
    return undefined;
  }
  return (
    delegateToolsSummary(calls, live) ??
    (live ? "Using MonoCode" : "Used MonoCode")
  );
}
