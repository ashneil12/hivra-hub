// A saved filter is untrusted. A condition this build does not understand is skipped, so one bad
// field cannot hide every task, and it never throws.

import { isGroup, resolveDateValue, type Condition, type DateValue, type FilterGroup, type FilterNode } from "../vendor/views/viewState";

export type MatchTask = {
  title?: string;
  description?: string;
  status?: string;
  category?: string;
  priority?: string;
  assignee?: string | null;
  projectId?: string;
  labels?: readonly string[];
  parentId?: string | null;
  dueAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  subIssueCount?: number;
  creatorId?: string;
};

export type MatchContext = { now?: Date; currentUserId?: string };

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function dateOf(value: unknown, now: Date): string | null {
  if (!value || typeof value !== "object") return null;
  const date = value as { absolute?: unknown; relative?: unknown };
  if (typeof date.absolute === "string") return date.absolute;
  if (typeof date.relative === "string") {
    try {
      return resolveDateValue(value as DateValue, now);
    } catch {
      return null;
    }
  }
  return null;
}

function day(millis: number | null | undefined): string | null {
  if (typeof millis !== "number" || !Number.isFinite(millis)) return null;
  return new Date(millis).toISOString().slice(0, 10);
}

function has(values: string[] | null, value: string | null | undefined): boolean {
  return values !== null && value != null && values.includes(value);
}

/** True when the condition is understood and matches. Null means "skip this condition". */
function conditionMatches(task: MatchTask, condition: Condition, ctx: MatchContext): boolean | null {
  const now = ctx.now ?? new Date();
  const values = strings(condition.value);
  const one = values && values.length === 1 ? values[0] : null;
  const assignee = condition.field === "assignee" && one === "me" ? ctx.currentUserId ?? null : one;
  switch (condition.field) {
    case "text": {
      if (condition.operator !== "contains" || typeof condition.value !== "string") return null;
      const haystack = `${task.title ?? ""}\n${task.description ?? ""}`.toLowerCase();
      return haystack.includes(condition.value.toLowerCase());
    }
    case "status":
      if (condition.operator === "is") return has(values, task.status);
      if (condition.operator === "is_not") return values !== null && !values.includes(task.status ?? "");
      return null;
    case "status_category":
      if (condition.operator === "is") return has(values, task.category);
      if (condition.operator === "is_not") return values !== null && !values.includes(task.category ?? "");
      return null;
    case "priority":
      if (condition.operator === "is") return has(values, task.priority ?? "none");
      if (condition.operator === "is_not") return values !== null && !values.includes(task.priority ?? "none");
      return null;
    case "project":
      if (condition.operator === "is") return has(values, task.projectId);
      if (condition.operator === "is_not") return values !== null && !values.includes(task.projectId ?? "");
      return null;
    case "assignee":
      if (condition.operator === "is_empty") return !task.assignee;
      if (condition.operator === "is_not_empty") return Boolean(task.assignee);
      if (condition.operator === "is") return assignee !== null && task.assignee === assignee;
      if (condition.operator === "is_not") return values !== null && task.assignee !== assignee;
      return null;
    case "creator":
      if (condition.operator === "is") return has(values, task.creatorId);
      if (condition.operator === "is_not") return values !== null && !values.includes(task.creatorId ?? "");
      return null;
    case "label": {
      const labels = task.labels ?? [];
      if (condition.operator === "is_empty") return labels.length === 0;
      if (condition.operator === "is_not_empty") return labels.length > 0;
      if (!values) return null;
      if (condition.operator === "includes_any") return values.some((label) => labels.includes(label));
      if (condition.operator === "includes_all") return values.every((label) => labels.includes(label));
      if (condition.operator === "excludes") return values.every((label) => !labels.includes(label));
      return null;
    }
    case "parent":
      if (condition.operator === "is") {
        if (one === "none") return !task.parentId;
        return one !== null && task.parentId === one;
      }
      if (condition.operator === "is_not") return one !== null && task.parentId !== one;
      return null;
    case "sub_issues":
      if (condition.operator !== "is" || one === null) return null;
      if (one === "none") return (task.subIssueCount ?? 0) === 0;
      if (one === "any") return (task.subIssueCount ?? 0) > 0;
      return null;
    case "due_date":
    case "created_at":
    case "updated_at": {
      const stamp = condition.field === "due_date" ? task.dueAt : condition.field === "created_at" ? task.createdAt : task.updatedAt;
      if (condition.operator === "is_empty") return !day(stamp);
      if (condition.operator === "is_not_empty") return Boolean(day(stamp));
      const own = day(stamp);
      if (condition.operator === "before") {
        const bound = dateOf(condition.value, now);
        return bound !== null && own !== null && own < bound;
      }
      if (condition.operator === "after") {
        const bound = dateOf(condition.value, now);
        return bound !== null && own !== null && own > bound;
      }
      if (condition.operator === "between" && Array.isArray(condition.value) && condition.value.length === 2) {
        const start = dateOf(condition.value[0], now);
        const end = dateOf(condition.value[1], now);
        return start !== null && end !== null && own !== null && own >= start && own <= end;
      }
      return null;
    }
    default:
      return null;
  }
}

function nodeMatches(task: MatchTask, node: FilterNode, ctx: MatchContext): boolean | null {
  if (isGroup(node)) return groupMatches(task, node, ctx);
  if (!node || typeof node !== "object" || typeof (node as Condition).field !== "string") return null;
  return conditionMatches(task, node, ctx);
}

function groupMatches(task: MatchTask, group: FilterGroup, ctx: MatchContext): boolean {
  if ((group.op !== "and" && group.op !== "or") || !Array.isArray(group.children)) return true;
  const results = group.children.map((child) => nodeMatches(task, child, ctx)).filter((result): result is boolean => result !== null);
  if (results.length === 0) return true;
  return group.op === "or" ? results.some(Boolean) : results.every(Boolean);
}

/** An empty or unreadable filter shows every task. */
export function taskMatches(task: MatchTask, filter: FilterGroup | null | undefined, ctx: MatchContext = {}): boolean {
  if (!filter || !isGroup(filter)) return true;
  try {
    return groupMatches(task, filter, ctx);
  } catch {
    return true;
  }
}
