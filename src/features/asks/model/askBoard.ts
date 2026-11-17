// "You asked" as a board (Ash, 17 Nov: "a main chat in the center ... at the side something like sticky notes that pop
// up, grouped per project"). The same asks the list always showed (askedView.ts, read from the one ask ledger), stacked
// under the project each one is for, so a long dump into the one chat reads as a few short stacks instead of one long
// list. This file is the pure part: which project an ask is for, which Needs you item it waits on, and the stacks in the
// order they show. Nothing here touches disk, a model or the screen.
//
// Which project an ask is for, most exact first:
//  1. Where he put it himself (`project` on the ask, askStore.place).
//  2. The project of the newest job that took it on.
//  3. The project of the first mate whose chat he said it in, when that first mate works on one project.
//  4. The project the chat's folder is in.
//  5. The one project its words name (a project's name, or one of its first mates' names).
//  6. The project of the Needs you item it waits on (its own row once it went quiet, or a job of its that stopped).
// An ask that none of these places waits under "Not sorted yet", where one tap places it.
import { answeredLine } from "../../needs/model/answeredNeeds";
import type { AskedRow } from "./askedView";
import { textProjects, type LensProject } from "./chiefLens";

/** What the board reads of a job (a delegation row). */
export type BoardJob = { id: string; project?: string | null; childSession?: string | null };

/** What the board reads of a Needs you item. */
export type BoardNeed = {
  key: string;
  kind: string;
  projectId?: string;
  sentence: string;
  open?: { where: string; id: string };
};

export type BoardContext = {
  /** The projects in the order the app shows them, each with its first mates' names. */
  projects: readonly LensProject[];
  jobs?: readonly BoardJob[];
  needs?: readonly BoardNeed[];
  /** The one project a first mate works on. */
  mateProject?: (mateId: string) => string | undefined;
  /** The project a chat belongs to. */
  chatProject?: (chatId: string) => string | undefined;
};

export type BoardNote = AskedRow & {
  /** The project it sits under; none while it is not sorted. */
  projectId?: string;
  /** The Needs you item it waits on, by key: the note opens that item's own card. */
  needKey?: string;
};

export const UNSORTED = "unsorted";
export const IDEAS = "ideas";

export type BoardStack = {
  /** A project's id, or UNSORTED, or IDEAS. */
  id: string;
  kind: "project" | "unsorted" | "ideas";
  name: string;
  /** Open notes only: the ones that need him first, then the newest. */
  notes: BoardNote[];
  /** How many of them are red. */
  needs: number;
};

export type Board = {
  stacks: BoardStack[];
  /** Done asks, newest first, each still carrying its project. */
  finished: BoardNote[];
  open: number;
  needs: number;
  /** False with fewer than two projects: one stack with no name over it, the plain list it always was. */
  byProject: boolean;
};

type Placed = Pick<AskedRow, "project" | "jobs" | "mateId" | "chatId" | "title" | "words">;

/** The project an ask is for, or undefined while nothing places it. */
export function askProject(row: Placed, context: BoardContext): string | undefined {
  const known = (id: string | null | undefined): id is string => !!id && context.projects.some((project) => project.id === id);
  if (known(row.project)) return row.project;
  for (const id of [...(row.jobs ?? [])].reverse()) {
    const project = context.jobs?.find((job) => job.id === id)?.project;
    if (known(project)) return project;
  }
  const mate = context.mateProject?.(row.mateId);
  if (known(mate)) return mate;
  const chat = context.chatProject?.(row.chatId);
  if (known(chat)) return chat;
  const named = textProjects(`${row.title}\n${row.words}`, { projects: context.projects });
  return named.size === 1 ? [...named][0] : undefined;
}

const evened = (value: string) =>
  value
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:…]+$/, "");

/**
 * The Needs you item an open ask waits on: its own row (an ask that went quiet), a job of its that stopped, or the
 * question its first mate says it waits on (the note of a waiting ask names it). Undefined when it waits on nothing the
 * list holds: the note alone says what it needs.
 */
export function askNeed(
  row: Pick<AskedRow, "id" | "open" | "jobs" | "status" | "note">,
  context: BoardContext,
  projectId?: string,
): BoardNeed | undefined {
  if (!row.open) return undefined;
  const needs = context.needs ?? [];
  const own = needs.find((need) => need.key === `ask:${row.id}`);
  if (own) return own;
  for (const id of row.jobs ?? []) {
    const chat = context.jobs?.find((job) => job.id === id)?.childSession;
    const stopped = needs.find(
      (need) =>
        need.kind === "stopped" &&
        (need.key.endsWith(`:${id}`) || need.open?.id === `app:${id}` || (!!chat && need.open?.where === "chat" && need.open.id === chat)),
    );
    if (stopped) return stopped;
  }
  if (row.status !== "waiting" || !row.note) return undefined;
  const note = evened(row.note);
  return needs.find((need) => {
    if (need.kind !== "question" && need.kind !== "approval") return false;
    if (projectId && need.projectId && need.projectId !== projectId) return false;
    const sentence = evened(need.sentence);
    return sentence.length >= 8 && note.includes(sentence);
  });
}

/**
 * What an ask becomes when the question it waited on is answered from Needs you: open again and carrying his answer
 * ("Answered: Take A. EXO lead has it."), so the note stops saying it waits on him and its first mate reads the answer
 * beside his next message (askNotes.ts). An ask that was not waiting is left as it is, and so is one whose own row was
 * answered (a quiet ask's answers change the ask themselves).
 */
export function askAnswered(
  row: Pick<AskedRow, "id" | "open" | "status">,
  answer: { key: string; words: string; who: string; line?: string },
): { status: "heard"; note: string } | undefined {
  if (!row.open || row.status !== "waiting" || answer.key === `ask:${row.id}`) return undefined;
  if (!answer.words.trim() && !answer.line) return undefined;
  return { status: "heard", note: answeredLine(answer) };
}

/** Every ask on the list as a note: where it sits and what it waits on. A note that waits on a Needs you item is red. */
export function boardNotes(rows: readonly AskedRow[], context: BoardContext): BoardNote[] {
  const known = (id: string | undefined) => (id && context.projects.some((project) => project.id === id) ? id : undefined);
  return rows.map((row) => {
    const placed = askProject(row, context);
    const need = askNeed(row, context, placed);
    const projectId = placed ?? known(need?.projectId);
    return {
      ...row,
      ...(projectId ? { projectId } : {}),
      ...(need ? { needKey: need.key, red: true } : {}),
    };
  });
}

/**
 * The board: "Not sorted yet" on top (what just came in and has no project), then one stack per project in the app's
 * own order, then ideas kept for later that belong to no project. A stack with nothing open is left out. `rows` come
 * newest first (askedView.ts askedRows) and stay so inside a stack, after the red ones.
 */
export function askBoard(rows: readonly AskedRow[], context: BoardContext): Board {
  const notes = boardNotes(rows, context);
  const open = notes.filter((note) => note.open);
  const finished = notes.filter((note) => !note.open);
  const redFirst = (list: BoardNote[]) => [...list.filter((note) => note.red), ...list.filter((note) => !note.red)];
  const stack = (id: string, kind: BoardStack["kind"], name: string, list: BoardNote[]): BoardStack => ({
    id,
    kind,
    name,
    notes: redFirst(list),
    needs: list.filter((note) => note.red).length,
  });
  const byProject = context.projects.length > 1;
  const needs = open.filter((note) => note.red).length;
  if (!byProject) return { stacks: open.length ? [stack(UNSORTED, "unsorted", "", open)] : [], finished, open: open.length, needs, byProject };
  const loose = open.filter((note) => !note.projectId);
  const stacks = [
    stack(UNSORTED, "unsorted", "Not sorted yet", loose.filter((note) => note.kind !== "idea")),
    ...context.projects.map((project) => stack(project.id, "project", project.name, open.filter((note) => note.projectId === project.id))),
    stack(IDEAS, "ideas", "Ideas, for later", loose.filter((note) => note.kind === "idea")),
  ].filter((entry) => entry.notes.length > 0);
  return { stacks, finished, open: open.length, needs, byProject };
}

/** The line beside a stack's name: "3 asks", "1 idea". */
export function stackCount(stack: Pick<BoardStack, "kind" | "notes">): string {
  const count = stack.notes.length;
  const [one, many] = stack.kind === "ideas" ? ["idea", "ideas"] : ["ask", "asks"];
  return `${count} ${count === 1 ? one : many}`;
}
