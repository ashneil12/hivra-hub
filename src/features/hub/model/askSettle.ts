// Settle Ash's asks against what was built (B5, I6). The ask ledger (asks/model/asks.ts, Ledger A: the one ledger, read
// here through asks/model/askedView.ts) keeps the rows; this file walks the open ones and asks the same question every
// time: does the build cover his words? Only a "right" answer closes an ask, a "fixed" whose build lines up with it, or a
// done claim with something behind it. A "fixed" or a done claim with nothing behind it leaves the row open, says in plain
// words what is missing, and sends one private check to the owning chat through the usual delivery (hubChecks.ts) so its
// card shows the still-open asks beside the verification line.
import type { Block, Session } from "../../sessions/model/session";
import { askStore } from "../../asks/model/askStore";
import { openAskRows, type AskedRow } from "../../asks/model/askedView";
import { CHECK_RULES } from "./checkerRules";
import {
  askCovered,
  coveringEvidence,
  doneClaimOf,
  evidenceSince,
  nowClaimOf,
  gapLine,
  type EvidenceSource,
} from "./askLedger";
import { builtEvidence } from "./dumpCheck";
import { CHECK_PREFIX, checkVerdict, type HubCheck } from "./hubChecks";
import { forUser } from "./userName";

/** The chat's reply to one of his messages: its assistant text, up to his next message. */
function replyUntil(blocks: readonly Block[], index: number): string {
  const parts: string[] = [];
  for (let i = index + 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.role === "user" && !block.internal && !block.draft) break;
    if (block.role === "assistant" && block.text?.trim()) parts.push(block.text.trim());
  }
  return parts.join("\n\n");
}

/** The `[MonoCode check]` turn that answered one of his messages, as the turn's blocks. */
function checkTurnFor(blocks: readonly Block[], blockId: string): Block[] | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.monoCheck?.dumpId !== blockId) continue;
    const turn = [block];
    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j];
      if (next.role === "user" && !next.internal) break;
      turn.push(next);
    }
    return turn;
  }
  return undefined;
}

/** The private check sent into the chat that owns an ask. */
function askCheck(ask: AskedRow, finding: string, body: string, id: string, rules: string = CHECK_RULES): HubCheck {
  return {
    id,
    dumpId: ask.blockId,
    owner: ask.chatId,
    chatId: ask.chatId,
    finding,
    askIds: [ask.id],
    prompt: forUser`${CHECK_PREFIX} ${body}\n${rules}`,
  };
}

/** A "fixed" the build does not back up: it stays open and the chat is asked once. */
async function holdFixed(ask: AskedRow, gap: string): Promise<HubCheck> {
  await askStore().check(ask.id, { gap, held: null });
  return askCheck(
    ask,
    `- "${ask.title}" was answered fixed, but nothing built since it lines up`,
    `Ash asked: "${ask.title}". This chat answered Fixed, but ${gap}. Run the project's own verification for it and close that gap.`,
    `dc-${ask.blockId}-gap`,
  );
}

/** A done claim with an open ask behind it: the claim is not recorded, and the card shows what is still open. */
async function holdClaim(ask: AskedRow, claim: string, gap: string): Promise<HubCheck> {
  await askStore().check(ask.id, { gap, held: { claim, at: Date.now() } });
  return askCheck(
    ask,
    `- "${ask.title}" was called done with nothing built for it`,
    `This chat called it done ("${claim}"), but Ash asked: "${ask.title}", and ${gap}. A done claim is not recorded while that is open. Run the project's own verification for it and close the gap.`,
    `dc-${ask.blockId}-held`,
  );
}

/**
 * r85: the chat said the work is in or now does something while its own job for it is still being built: one check
 * asks it to say so plainly, instead of running the verification itself (the job's report brings that).
 */
/**
 * r99 (B5 df53, +423s to +470s): "Fixed: ... under way" then "Right: that Fixed line was ..." four times in a row: the
 * correction carried the checker's label, and its "Fixed" read as a new done claim. A correction is said plainly.
 */
export const EARLY_RULES = `Reply in one plain line, with no "Right:" or "Fixed:" label: it's a correction, not a fix.`;

async function holdEarly(ask: AskedRow, claim: string, jobs: readonly string[]): Promise<HubCheck> {
  await askStore().check(ask.id, { held: { claim, at: Date.now() } });
  const named = jobs.slice(0, 3).map((title) => `"${title}"`).join(", ");
  return askCheck(
    ask,
    `- "${ask.title}" was said to be in while ${named} is still being built`,
    `This chat said "${claim}", but ${named} ${jobs.length > 1 ? "are" : "is"} still being built and nothing of it has landed in the project. Tell Ash in one line that it is under way, not in yet, and say it is in only when its report says it landed. Don't run the work or its checks yourself.`,
    `dc-${ask.blockId}-early`,
    EARLY_RULES,
  );
}

/**
 * Compare every open ask with the build in its chat: the tool blocks after his message, the commits in the chat's
 * folder since he said it (whoever made them), and the Bot changes rows (askEvidence.ts). Runs after each idle flush,
 * next to the dump look. A chat that is busy or has a message waiting is left until it is done, so nothing is read
 * halfway through a turn.
 */
export async function settleAsks(
  sessions: readonly Session[],
  source: EvidenceSource,
  offer: (checks: HubCheck[]) => unknown,
  options: {
    skip?: (sessionId: string) => boolean;
    /** r85: the titles of the chat's own jobs still being built (open delegations it owns). */
    openJobs?: (sessionId: string) => readonly string[];
  } = {},
): Promise<void> {
  const store = askStore();
  const asks = openAskRows(await store.load());
  if (!asks.length) return;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const checks: HubCheck[] = [];
  for (const ask of asks) {
    const session = byId.get(ask.chatId);
    if (!session || session.busy || session.queuedMessages?.length) continue;
    if (session.id.startsWith("app-") || options.skip?.(session.id)) continue;
    const index = session.blocks.findIndex((block) => block.id === ask.blockId);
    if (index < 0) continue;
    const evidence = [
      ...builtEvidence(session.blocks, index),
      ...(await evidenceSince({ cwd: session.cwd, since: ask.at }, source)),
    ];
    const turn = checkTurnFor(session.blocks, ask.blockId);
    const verdict = turn ? checkVerdict(turn) : undefined;
    const checkId = turn?.[0].monoCheck?.id ?? "";
    if (verdict) {
      // One answer settles an ask once, however often the chat is read.
      if (ask.check?.settled === checkId) continue;
      await store.check(ask.id, { settled: checkId });
      if (verdict === "right") {
        await store.handle(ask.id, evidenceLineOf(ask, evidence, "answered right as it is"));
        continue;
      }
      if (askCovered(ask, evidence)) {
        await store.handle(ask.id, evidenceLineOf(ask, evidence, "answered fixed, and the build shows"));
        continue;
      }
      if (ask.check?.reopen === checkId) continue;
      await store.check(ask.id, { reopen: checkId });
      checks.push(await holdFixed(ask, gapLine(ask, evidence)));
      continue;
    }
    const reply = replyUntil(session.blocks, index);
    const jobs = options.openJobs?.(session.id) ?? [];
    // r85: while its job is still out, "now does X" counts as a claim too, and the check says to wait for the report.
    const early = jobs.length ? (doneClaimOf(reply) ?? nowClaimOf(reply)) : undefined;
    if (early && !askCovered(ask, evidence)) {
      if (ask.check?.held?.claim !== early) checks.push(await holdEarly(ask, early, jobs));
      continue;
    }
    const claim = doneClaimOf(reply);
    if (!claim) continue;
    if (askCovered(ask, evidence)) {
      await store.handle(ask.id, evidenceLineOf(ask, evidence, "called done, and the build shows"));
      continue;
    }
    // The same claim already held: nothing new to say until the chat answers.
    if (ask.check?.held?.claim === claim) continue;
    checks.push(await holdClaim(ask, claim, gapLine(ask, evidence)));
  }
  if (checks.length) await offer(checks);
}

/** "…: committed abc123 fixed the save (src/save.ts)", or just the plain words when nothing lines up. */
function evidenceLineOf(ask: AskedRow, evidence: readonly string[], how: string): string {
  const cover = coveringEvidence(ask, evidence);
  return cover ? `${how}: ${cover}` : how;
}
