// WP-250: which tasks a first mate picks up by itself. The rule is checked in Rust (`src-tauri/src/tasks/pickup.rs`);
// this file only reads, writes and words it.

import { invoke } from "@tauri-apps/api/core";
import type { Mono } from "../../monos/model/mono";

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

export type FirstMateChoice = { session: string; name: string };

const CHECKER_ID = "checker";

function folderKey(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * The first mates a rule in this project may name: the Monos that work on it (its folder, or `hub-project:<id>` for a
 * project with none), never the checker. Each is offered by the chat it works this project in, so the id Ash never
 * sees is the one saved. The store refuses a chat that isn't there.
 */
export function firstMatesFor(
  monos: readonly Mono[],
  project: string,
  folder: string,
  nameOf: (mono: Mono) => string,
): FirstMateChoice[] {
  const keys = new Set([folder, `hub-project:${project}`, project].filter(Boolean).map(folderKey));
  const out: FirstMateChoice[] = [];
  for (const mono of monos) {
    if (mono.id === CHECKER_ID) continue;
    if (!mono.projects.some((p) => keys.has(folderKey(p)))) continue;
    const session = mono.projectSessions?.[project] ?? mono.sessionId;
    if (!session || out.some((m) => m.session === session)) continue;
    out.push({ session, name: nameOf(mono) });
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
  // A rule from before every rule named a project takes nothing; it can only be removed.
  if (!rule.project) return `Takes nothing until it names a project (remove it and add it again)`;
  const where = rule.project === here ? " in this project" : ` in ${rule.project}`;
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
