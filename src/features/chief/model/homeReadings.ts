// WP-88: what Home already loaded, as readings the chief can cite. Nothing here is an instruction.

import { hubProjectId, type HomeChat, type HomeDecision, type HomeDoc, type HomeProject, type HomeTask } from "../../home/model/lines";
import type { Reading } from "./answer";

function stuck(task: HomeTask): boolean {
  return task.needsYou || /stuck|blocked/i.test(task.status);
}

/** Tasks, pages, decisions and chats from one home snapshot. A trashed row is not a reading. */
export function readingsOf(input: {
  projects: readonly HomeProject[];
  tasks: readonly HomeTask[];
  docs: readonly HomeDoc[];
  decisions: readonly HomeDecision[];
  chats: readonly HomeChat[];
}): Reading[] {
  const out: Reading[] = [];
  for (const task of input.tasks) {
    if (!task.id || task.trashedAt) continue;
    out.push({
      kind: "task",
      id: task.id,
      projectId: hubProjectId(task.projectId, input.projects),
      text: task.title,
      stuck: stuck(task),
    });
  }
  for (const doc of input.docs) {
    if (!doc.id || doc.trashedAt) continue;
    out.push({ kind: "doc", id: doc.id, projectId: "", text: doc.title, stuck: false });
  }
  for (const decision of input.decisions) {
    if (!decision.decisionKey || !decision.question) continue;
    out.push({
      kind: "decision",
      id: decision.decisionKey,
      projectId: hubProjectId(decision.project, input.projects),
      text: decision.question,
      stuck: false,
    });
  }
  for (const chat of input.chats) {
    if (!chat.id) continue;
    out.push({
      kind: "chat",
      id: chat.id,
      projectId: hubProjectId(chat.projectId, input.projects),
      text: chat.title,
      stuck: false,
    });
  }
  return out;
}
