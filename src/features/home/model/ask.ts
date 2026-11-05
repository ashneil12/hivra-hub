// A later ask wins. A file that resolves after a newer ask does not paint over it.

import { askChief, type AnswerLine, type Reading } from "../../chief/model/answer";
import type { CopyProject } from "../../chief/model/reads";

export type HomeReply = {
  text?: string;
  notes?: AnswerLine[];
};

type Filed = { ok: true; id?: string } | { ok: false; text: string };

/** Home's ask. The token drops a result that belongs to an ask the person has already replaced. */
export function createHomeAsks(file: (projectId: string, title: string) => Promise<Filed>) {
  let token = 0;
  return {
    async ask(
      text: string,
      input: { readings: readonly Reading[]; projects: readonly CopyProject[]; loaded: boolean },
    ): Promise<HomeReply | undefined> {
      const mine = ++token;
      const result = askChief(text, input);
      if (result.kind === "question") return mine === token ? { text: result.text } : undefined;
      if (result.kind === "lines") {
        if (mine !== token) return undefined;
        return result.lines.length ? { notes: result.lines } : { text: "Nothing to say." };
      }
      const filed = await file(result.projectId, result.title);
      if (mine !== token) return undefined;
      return filed.ok
        ? { text: "Filed.", notes: filed.id ? [{ id: filed.id, kind: "task", text: result.title, projectId: result.projectId }] : [] }
        : { text: filed.text };
    },
  };
}
