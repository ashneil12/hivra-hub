import {
  automationTriggers,
  type Automation,
  type AutomationTrigger,
} from "./automations";
import { scrubShownText } from "./shownText";

/**
 * Where each automation sits between what starts it and where the work goes.
 * Phrases match `started_by` in `src-tauri/src/automations.rs`. This function
 * does not start, edit or delete anything, and it never reads the prompt.
 */
export const MAP_NODE_WIDTH = 196;
export const MAP_NODE_HEIGHT = 36;

const COLUMN_X = [16, 284, 552] as const;
const ROW = 48;
const TOP = 16;
const PAD = 16;

export type MapNodeKind = "trigger" | "automation" | "destination";

export type MapNode = {
  id: string;
  kind: MapNodeKind;
  label: string;
  x: number;
  y: number;
  /** Set only on an automation that is switched off. */
  disabled: boolean;
  /** The automation a click opens, when this node belongs to just one. */
  automationId: string;
};

export type MapEdge = {
  id: string;
  from: string;
  to: string;
};

export type MapLayout = {
  nodes: MapNode[];
  edges: MapEdge[];
  emptyMessage: string | null;
  width: number;
  height: number;
};

type ColumnItem = {
  id: string;
  label: string;
  disabled: boolean;
  automationId: string;
};

export function mapLayout(automations: readonly Automation[]): MapLayout {
  const rows = uniqueAutomations(automations);
  if (rows.length === 0) {
    return {
      nodes: [],
      edges: [],
      emptyMessage: "No automations yet",
      width: COLUMN_X[2] + MAP_NODE_WIDTH + PAD,
      height: TOP + ROW + PAD,
    };
  }

  const triggerUsers = new Map<string, string[]>();
  const destinationUsers = new Map<string, string[]>();
  const triggers = new Map<string, ColumnItem>();
  const destinations = new Map<string, ColumnItem>();
  const automationsColumn: ColumnItem[] = [];
  const edges: MapEdge[] = [];
  const seenEdges = new Set<string>();

  const addEdge = (from: string, to: string) => {
    const id = `${from}->${to}`;
    if (seenEdges.has(id)) return;
    seenEdges.add(id);
    edges.push({ id, from, to });
  };

  for (const automation of rows) {
    const automationNode = `automation:${automation.id}`;
    automationsColumn.push({
      id: automationNode,
      label: automationLabel(automation),
      disabled: automation.enabled === false,
      automationId: automation.id,
    });
    for (const trigger of automationTriggers(automation)) {
      for (const piece of triggerPieces(trigger)) {
        const id = `trigger:${piece.key}`;
        if (!triggers.has(id)) {
          triggers.set(id, {
            id,
            label: piece.label,
            disabled: false,
            automationId: "",
          });
        }
        const users = triggerUsers.get(id) ?? [];
        users.push(automation.id);
        triggerUsers.set(id, users);
        addEdge(id, automationNode);
      }
    }
    for (const destination of destinationsOf(automation)) {
      const id = `destination:${destination.key}`;
      if (!destinations.has(id)) {
        destinations.set(id, {
          id,
          label: scrubShownText(destination.label),
          disabled: false,
          automationId: "",
        });
      }
      const users = destinationUsers.get(id) ?? [];
      users.push(automation.id);
      destinationUsers.set(id, users);
      addEdge(automationNode, id);
    }
  }

  for (const [id, users] of triggerUsers) {
    const item = triggers.get(id);
    if (item && users.length === 1) item.automationId = users[0] ?? "";
  }
  for (const [id, users] of destinationUsers) {
    const item = destinations.get(id);
    if (item && users.length === 1) item.automationId = users[0] ?? "";
  }

  const columns: [MapNodeKind, ColumnItem[]][] = [
    ["trigger", [...triggers.values()]],
    ["automation", automationsColumn],
    ["destination", [...destinations.values()]],
  ];
  const nodes: MapNode[] = [];
  let tallest = 1;
  for (let column = 0; column < columns.length; column += 1) {
    const [kind, items] = columns[column]!;
    items.sort((a, b) => {
      const byLabel = a.label.localeCompare(b.label);
      return byLabel === 0 ? a.id.localeCompare(b.id) : byLabel;
    });
    tallest = Math.max(tallest, items.length);
    items.forEach((item, index) => {
      nodes.push({
        id: item.id,
        kind,
        label: item.label,
        x: COLUMN_X[column] ?? COLUMN_X[0],
        y: TOP + index * ROW,
        disabled: item.disabled,
        automationId: item.automationId,
      });
    });
  }

  return {
    nodes,
    edges,
    emptyMessage: null,
    width: COLUMN_X[2] + MAP_NODE_WIDTH + PAD,
    height: TOP + tallest * ROW + PAD,
  };
}

function uniqueAutomations(automations: readonly Automation[]): Automation[] {
  const seen = new Set<string>();
  const out: Automation[] = [];
  for (const automation of automations) {
    if (!automation || typeof automation.id !== "string") continue;
    const id = automation.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(automation);
  }
  return out;
}

function automationLabel(automation: Automation): string {
  const name = typeof automation.name === "string" ? automation.name.trim() : "";
  return scrubShownText(name || "Automation");
}

/** One node per repo. A time trigger stays one node. The key uses the scrubbed repo. */
function triggerPieces(trigger: AutomationTrigger): { key: string; label: string }[] {
  if (trigger.kind === "time") {
    return [{ key: triggerKey(trigger), label: scrubShownText(triggerLabel(trigger)) }];
  }
  const repos = uniqueRepos(trigger);
  if (repos.length === 0) {
    return [{ key: triggerKey(trigger), label: scrubShownText(triggerLabel(trigger)) }];
  }
  const noun = eventNoun(trigger.event);
  return repos.map((repo) => {
    const shown = scrubShownText(repo);
    return {
      key: ["event", trigger.kind, trigger.event, shown, text(trigger.branch)].join("\u0000"),
      label: shown ? `${noun} in ${shown}` : noun,
    };
  });
}

function uniqueRepos(trigger: AutomationTrigger): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string) => {
    const repo = text(value);
    if (!repo || seen.has(repo)) return;
    seen.add(repo);
    out.push(repo);
  };
  add(trigger.repo);
  for (const repo of trigger.repos ?? []) add(repo);
  return out;
}

/** Same words as `started_by` for a scheduled or event trigger. */
export function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.kind === "time") {
    if (trigger.scheduleKind === "hourly") return "The hourly schedule";
    const clock = clockPhrase(trigger.time);
    return clock ? `The ${clock} schedule` : "The schedule";
  }
  const noun = eventNoun(trigger.event);
  const repo = triggerRepo(trigger);
  return repo ? `${noun} in ${repo}` : noun;
}

function eventNoun(event: string): string {
  switch (event) {
    case "issue_opened":
    case "issue_created":
      return "A new issue";
    case "pull_request_opened":
    case "pull_request_appeared":
    case "draft_opened":
      return "A new pull request";
    case "merge_request_opened":
      return "A new merge request";
    case "work_item_appeared":
      return "A new work item";
    default:
      return "An event";
  }
}

function triggerRepo(trigger: AutomationTrigger): string {
  const repo = text(trigger.repo);
  if (repo) return repo;
  return (trigger.repos ?? []).map((item) => text(item)).find((item) => item.length > 0) ?? "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clockPhrase(time: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour > 23 || minute > 59) return null;
  return `${hour}:${match[2]}`;
}

function triggerKey(trigger: AutomationTrigger): string {
  if (trigger.kind === "time") {
    return [
      "time",
      trigger.scheduleKind,
      trigger.time,
      String(trigger.minute),
      String(trigger.dayOfWeek),
    ].join("\u0000");
  }
  const repos = (trigger.repos ?? [])
    .map((repo) => text(repo))
    .filter((repo) => repo.length > 0)
    .sort();
  return [
    "event",
    trigger.kind,
    trigger.event,
    text(trigger.repo),
    repos.join("\u0001"),
    text(trigger.branch),
  ].join("\u0000");
}

function destinationsOf(automation: Automation): { key: string; label: string }[] {
  const cwd = typeof automation.cwd === "string" ? automation.cwd : "";
  const out = [{ key: `folder\u0000${cwd.trim()}`, label: folderLabel(cwd) }];
  if (automation.workspaceMode === "worktree") {
    out.push({ key: "worktree\u0000fresh", label: "A fresh worktree" });
  } else if (automation.workspaceMode === "existing") {
    const path = (automation.worktreeCwd ?? "").trim();
    if (path) out.push({ key: `worktree\u0000${path}`, label: folderLabel(path) });
  }
  if (automation.reuseSession) {
    out.push({ key: "chat\u0000last", label: "The last chat" });
  }
  return out;
}

function folderLabel(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/u, "");
  if (!trimmed || trimmed === "." || trimmed === "~") return "This folder";
  const parts = trimmed.split(/[\\/]/u).filter((part) => part.length > 0);
  const last = parts[parts.length - 1] ?? "";
  if (!last || last === "." || last === "..") return "This folder";
  return last;
}
