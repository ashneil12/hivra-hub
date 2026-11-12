// WP-250: which tasks a first mate picks up by itself. The rule is checked in Rust (`src-tauri/src/tasks/pickup.rs`);
// this file only reads, writes and words it.

import { invoke } from "@tauri-apps/api/core";

export type PickupRule = {
  ownerSession: string;
  project: string | null;
  statuses: string[];
  labels: string[];
  enabled: boolean;
  createdAt: number;
};

const PERSON = { id: "person", project: "", kind: "person" };

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readPickupRules(raw: unknown): PickupRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.ownerSession !== "string" || !row.ownerSession) return [];
    return [
      {
        ownerSession: row.ownerSession,
        project: typeof row.project === "string" && row.project ? row.project : null,
        statuses: list(row.statuses),
        labels: list(row.labels),
        enabled: row.enabled !== false,
        createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
      },
    ];
  });
}

/** "Todo, In review" becomes ["Todo", "In review"]; blanks and repeats go. */
export function splitNames(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(",")) {
    const name = part.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** One line a person can read: what the first mate takes. */
export function describeRule(
  rule: Pick<PickupRule, "project" | "statuses" | "labels" | "enabled">,
  here?: string,
): string {
  const parts: string[] = [];
  parts.push(rule.statuses.length ? `status ${rule.statuses.join(" or ")}` : "any status");
  if (rule.labels.length) parts.push(`labelled ${rule.labels.join(" and ")}`);
  const where = !rule.project ? " in any project" : rule.project === here ? " in this project" : ` in ${rule.project}`;
  const line = `Takes unassigned tasks${where} with ${parts.join(", ")}`;
  return rule.enabled ? line : `${line} (off)`;
}

export async function loadPickupRules(): Promise<PickupRule[]> {
  return readPickupRules(await invoke("tasks_pickup_rules"));
}

export async function savePickupRule(rule: Omit<PickupRule, "createdAt">): Promise<void> {
  await invoke("tasks_pickup_rule_put", { actor: PERSON, rule: { ...rule, createdAt: 0 } });
}

export async function removePickupRule(ownerSession: string): Promise<void> {
  await invoke("tasks_pickup_rule_remove", { actor: PERSON, ownerSession });
}
