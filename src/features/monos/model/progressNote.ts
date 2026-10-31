// r101 (5, B5 571a: the Lead said nothing from +360s to +2050s while its worker ran): a Lead with work out for about
// ten minutes gets one grey app line saying what moved ("Still working: 2 of 5 jobs done."). It carries no Needs you,
// badge or rail count (a plain system block), and only appears when something moved since the last one.
import type { Block, Session } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation } from "./delegations";

export const PROGRESS_PREFIX = "progress-";
export const PROGRESS_QUIET_MS = 10 * 60_000;

const said = (block: Block) =>
  (block.role === "assistant" && !block.tool && !block.internal && !!block.text.trim()) || block.id.startsWith(PROGRESS_PREFIX);

/** "2 of 5" from an earlier note's id (progress-<done>-<total>-<at>). */
function lastNote(chat: Session): { done: number; total: number; at: number } | undefined {
  for (let i = chat.blocks.length - 1; i >= 0; i--) {
    const m = /^progress-(\d+)-(\d+)-(\d+)$/.exec(chat.blocks[i]!.id);
    if (m) return { done: Number(m[1]), total: Number(m[2]), at: Number(m[3]) };
  }
  return undefined;
}

export function progressNote(chat: Session, rows: readonly Delegation[], now = Date.now()): Block | undefined {
  // Its jobs since Ash's last message: the work in hand.
  const ask = [...chat.blocks].reverse().find((b) => b.role === "user" && !b.draft && !b.monoNote && !/^\s*\[MonoCode /.test(b.text));
  const since = ask?.startedAt ?? ask?.sentAt ?? 0;
  const own = rows.filter((row) => row.ownerSession === chat.id && row.createdAt >= since);
  if (!own.some((row) => isOpenDelegation(row))) return undefined;
  const total = own.length;
  const done = own.filter((row) => row.state === "completed").length;
  const prev = lastNote(chat);
  // Nothing moved: silent. Before any note, nothing moved until a job came back.
  if (prev ? prev.done === done && prev.total === total : done === 0) return undefined;
  // Quiet for about ten minutes: no word from the Lead and no note since.
  const lastSaid = Math.max(
    prev?.at ?? 0,
    ...own.map((row) => row.createdAt),
    ...chat.blocks.filter(said).map((b) => b.startedAt ?? b.sentAt ?? 0),
  );
  if (now - lastSaid < PROGRESS_QUIET_MS) return undefined;
  return { id: `${PROGRESS_PREFIX}${done}-${total}-${now}`, role: "system", text: `Still working: ${done} of ${total} jobs done.` };
}
