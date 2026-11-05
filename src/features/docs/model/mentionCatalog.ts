// Who an @ can name (WP-72): pages, tasks, chats and Monos in this project.
// Tasks are absent until WP-70. A chat that is not a real project chat is left out.

import { inProjectScope } from "../../projects/model/projectScope";
import type { MentionTarget } from "./types";

export type CatalogChat = {
  id: string;
  title: string;
  cwd?: string | null;
  inboxAsk?: unknown;
  ephemeral?: boolean;
  orchestrationLeadId?: string;
};

export type CatalogMono = {
  id: string;
  name?: string;
  projects?: readonly string[];
};

function add(out: MentionTarget[], seen: Set<string>, target: MentionTarget) {
  const id = target.id.trim();
  if (!id) return;
  const key = `${target.kind}:${id}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ kind: target.kind, id, name: target.name.trim() || "Untitled" });
}

/** The mention menu. `extra` fills kinds this screen does not load itself, such as tasks. */
export function mentionCatalog(input: {
  pages?: readonly { id: string; title: string }[];
  chats?: readonly CatalogChat[];
  monos?: readonly CatalogMono[];
  tasks?: readonly { id: string; title: string }[];
  extra?: readonly MentionTarget[];
  scope?: string;
}): MentionTarget[] {
  const out: MentionTarget[] = [];
  const seen = new Set<string>();
  for (const page of input.pages ?? []) {
    add(out, seen, { kind: "page", id: page.id, name: page.title });
  }
  for (const task of input.tasks ?? []) {
    add(out, seen, { kind: "task", id: task.id, name: task.title });
  }
  for (const chat of input.chats ?? []) {
    if (chat.inboxAsk || chat.ephemeral || chat.orchestrationLeadId) continue;
    if (!inProjectScope(chat.cwd, input.scope)) continue;
    add(out, seen, { kind: "chat", id: chat.id, name: chat.title });
  }
  for (const mono of input.monos ?? []) {
    const projects = mono.projects ?? [];
    const here =
      !input.scope ||
      projects.length === 0 ||
      projects.some((project) => inProjectScope(project, input.scope));
    if (!here) continue;
    add(out, seen, { kind: "mono", id: mono.id, name: mono.name ?? "" });
  }
  for (const target of input.extra ?? []) add(out, seen, target);
  return out;
}
