// PT-5: the webview's half of test debt (src-tauri/src/test_debt). In a project that tests "at ship", a failing test that is not a task's
// own goes on a list instead of sending the task back, and the list is sorted once, when the ship check runs, by ONE "test fixer"
// task. The app decides and claims; this file does what only the webview can:
//   - starts the fixer task through the existing delegation path (`tasks.delegate`, as a normal worker task owned by the first mate
//     whose chat ran the ship check, on its own checkout, in the background), and
//   - files each Needs-you item through the existing ask path (`tasks.ask`): a real bug a test caught ("<test> fails because the code
//     is wrong: <one line>"), and a test that broke five times and caught nothing ("Rewrite it / Delete it / Keep it"). Each is claimed
//     in the app first, which is what makes it once. Nothing is ever deleted here: a rewrite or a delete is a task the first mate briefs.
// Every answer from the app is untrusted: a shape this file can't read starts nothing and files nothing.
import { invoke } from "@tauri-apps/api/core";
import { markAppDelegate } from "./agentAppTasks";

/** The app's side, as invokes. A test swaps it for a fake. */
export type TestDebtBackend = {
  /** Claims the project's one fixer slot and answers the task to start (or nothing, when one holds it or none is due). */
  fixerClaim(cwd: string): Promise<unknown>;
  fixerStarted(cwd: string, token: string, childSession: string): Promise<unknown>;
  fixerRelease(cwd: string, token: string): Promise<unknown>;
  claim(cwd: string, kind: "bug" | "proposal", key: string): Promise<unknown>;
  release(cwd: string, kind: "bug" | "proposal", key: string): Promise<unknown>;
  answer(cwd: string, id: string, answer: string): Promise<unknown>;
};

export const tauriTestDebt: TestDebtBackend = {
  fixerClaim: (cwd) => invoke("test_debt_fixer_claim", { cwd }),
  fixerStarted: (cwd, token, childSession) => invoke("test_debt_fixer_started", { cwd, token, childSession }),
  fixerRelease: (cwd, token) => invoke("test_debt_fixer_release", { cwd, token }),
  claim: (cwd, kind, key) => invoke("test_debt_claim", { cwd, kind, key }),
  release: (cwd, kind, key) => invoke("test_debt_release", { cwd, kind, key }),
  answer: (cwd, id, answer) => invoke("test_debt_answer", { cwd, id, answer }),
};

export type FixerRequest = { token: string; title: string; brief: string; goal: string; count: number };
export type BugAsk = { key: string; test: string; file: string; line: string };
export type ProposalAsk = { id: string; test: string; broke: number };
/**
 * What a ship check run says follows from the list. `fixerDue` only says the list has tests to sort: the slot is claimed by the call
 * that starts the task (`startTestFixer`), so a ship check run from a card, which starts nothing, claims nothing.
 */
export type TestDebtFollow = { fixerDue: boolean; bugs: BugAsk[]; proposals: ProposalAsk[] };

/** A task's request id: letters, digits, underscores and hyphens (the app's own rule for `tasks.delegate`). */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const BRIEF_MAX = 30_000;
const ASKS_MAX = 10;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** The task the app claimed the fixer slot for, read defensively: anything that could not start a task is nothing. */
export function readFixerRequest(value: unknown): FixerRequest | null {
  const fixer = record(value);
  if (!fixer) return null;
  const token = typeof fixer.token === "string" && REQUEST_ID.test(fixer.token) ? fixer.token : undefined;
  const title = str(fixer.title, 200);
  const brief = str(fixer.brief, BRIEF_MAX);
  const goal = str(fixer.goal, 1_000);
  const count = typeof fixer.count === "number" && Number.isInteger(fixer.count) && fixer.count > 0 ? fixer.count : undefined;
  return token && title && brief && goal && count ? { token, title, brief, goal, count } : null;
}

/** What a ship check run says follows from the list. A bad entry is dropped; an answer that isn't an object is nothing. */
export function readTestDebtFollow(value: unknown): TestDebtFollow {
  const row = record(value);
  const out: TestDebtFollow = { fixerDue: false, bugs: [], proposals: [] };
  if (!row) return out;
  out.fixerDue = row.fixerDue === true;
  const seen = new Set<string>();
  for (const entry of Array.isArray(row.bugs) ? row.bugs : []) {
    if (out.bugs.length >= ASKS_MAX) break;
    const bug = record(entry);
    const key = str(bug?.key, 1_000);
    const test = str(bug?.test, 300);
    if (!bug || !key || !test || seen.has(key)) continue;
    seen.add(key);
    out.bugs.push({ key, test, file: str(bug.file, 400) ?? "", line: str(bug.line, 300) ?? "" });
  }
  const ids = new Set<string>();
  for (const entry of Array.isArray(row.proposals) ? row.proposals : []) {
    if (out.proposals.length >= ASKS_MAX) break;
    const proposal = record(entry);
    const id = str(proposal?.id, 1_000);
    const test = str(proposal?.test, 300);
    const broke = typeof proposal?.broke === "number" && Number.isInteger(proposal.broke) && proposal.broke > 0 ? proposal.broke : undefined;
    if (!proposal || !id || !test || !broke || ids.has(id)) continue;
    ids.add(id);
    out.proposals.push({ id, test, broke });
  }
  return out;
}

/** What `tasks.delegate` answers that this file reads. */
function childSessionOf(result: unknown): string | undefined {
  const row = record(result);
  const id = row?.childSessionId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export type FixerOutcome =
  | { started: true; taskId: string | null; title: string; note: string }
  | { started: false; note: string };

/**
 * Starts the ONE test fixer task. The app claims the project's fixer slot (under its lock, so two ship checks at once or two windows
 * never both get a task) and answers the brief it built; `delegate` is the existing `tasks.delegate` path, already bound to the first
 * mate's chat (so the task is its own, on its own checkout, and the report comes back to it as any worker's does). A start that fails
 * gives the slot back, so the next ship check may try again (a timeout is not a final failure).
 */
export async function startTestFixer(
  cwd: string,
  delegate: (token: string, input: Record<string, unknown>) => Promise<unknown>,
  backend: TestDebtBackend = tauriTestDebt,
  project?: string,
): Promise<FixerOutcome> {
  let claimed: unknown;
  try {
    claimed = await backend.fixerClaim(cwd);
  } catch (error) {
    const why = error instanceof Error && error.message ? error.message : String(error);
    return { started: false, note: `The test fixer could not be claimed this time (${why}). The next ship check starts it.` };
  }
  const fixer = readFixerRequest(claimed);
  if (!fixer) {
    const row = record(claimed);
    if (row) {
      // The app made a claim this can't read: it holds the slot until it is given back, so it is, by the request id it carries.
      const token = typeof row.token === "string" && REQUEST_ID.test(row.token) ? row.token : undefined;
      if (token) await backend.fixerRelease(cwd, token).catch(() => undefined);
      return {
        started: false,
        note: "The app's answer about the test fixer couldn't be read, so none was started. The next ship check tries again.",
      };
    }
    return {
      started: false,
      note: "A test fixer is already sorting this project's failing tests, or none is due. Do not start another.",
    };
  }
  let result: unknown;
  try {
    result = await delegate(
      fixer.token,
      // Marked as the app's own task: it is not told the worker sentence about carrying on past a failing test (it rewrites tests where
      // its brief says it may), and no agent can set the mark.
      markAppDelegate({
        intent: `Sort the ${fixer.count === 1 ? "failing test" : `${fixer.count} failing tests`} on this project's test debt list: decide each with evidence, and change a test only where the brief says you may.`,
        brief: fixer.brief,
        title: fixer.title,
        goal: fixer.goal,
        testFixer: true,
        // Not `code: true`: a fixer whose report only decides ("code is wrong", "flaky") changes nothing, and a code brief that changed
        // nothing is sent back for it. A fixer that does rewrite a test gets the gates its diff calls for, as every task does.
        ...(project ? { project } : {}),
      }),
    );
  } catch (error) {
    await backend.fixerRelease(cwd, fixer.token).catch(() => undefined);
    const why = error instanceof Error && error.message ? error.message : String(error);
    return {
      started: false,
      note: `The test fixer could not start this time (${why}). Nothing was lost: the next ship check starts it again.`,
    };
  }
  const child = childSessionOf(result);
  // The slot already holds the claim; remembering the child lets the app see when the task has ended. A failure here only means the
  // claim's grace decides, never a second fixer started on a guess.
  if (child) await backend.fixerStarted(cwd, fixer.token, child).catch(() => undefined);
  const taskId = (() => {
    const id = record(result)?.taskId;
    return typeof id === "string" ? id : null;
  })();
  return {
    started: true,
    taskId,
    title: fixer.title,
    note: `Started the test fixer (${fixer.title}) on its own checkout, in the background: carry on with the feature work. Its report comes back to you: it decides each test with evidence (code is wrong, test is out of date, or flaky). Run the ship check again once it has reported.`,
  };
}

/** What the person already answered, when the ask came back already answered. */
function alreadyAnswered(asked: unknown): string | null {
  const result = record(asked);
  if (!result || result.state !== "answered") return null;
  return typeof result.answer === "string" && result.answer.trim() ? result.answer.trim() : null;
}

type Claim = { claimed: boolean; key: string; question: string; options: string[]; recommended: string; note: string };

/** What the app says of a claim. An answer this file can't read is an error, never a guess. */
function readClaim(value: unknown): Claim | null {
  const view = record(value);
  if (!view || typeof view.claimed !== "boolean") return null;
  const note = typeof view.note === "string" ? view.note : "";
  if (!view.claimed) return { claimed: false, key: "", question: "", options: [], recommended: "", note };
  const key = str(view.key, 120);
  const question = str(view.question, 400);
  const options = Array.isArray(view.options) ? view.options : [];
  if (!key || !question || options.length < 2 || options.length > 6) return null;
  if (!options.every((option) => typeof option === "string" && option.trim() && option.length <= 200)) return null;
  const recommended = typeof view.recommended === "string" && options.includes(view.recommended) ? view.recommended : undefined;
  if (!recommended) return null;
  return { claimed: true, key, question, options: options as string[], recommended, note };
}

export type AskOutcome = { kind: "bug" | "proposal"; test: string; asked: boolean; note: string };

/** One claim, one question, once. A question that can't be filed (a timeout, the decision store unreachable) is given back. */
async function fileOne(
  cwd: string,
  kind: "bug" | "proposal",
  key: string,
  test: string,
  ask: (input: Record<string, unknown>) => Promise<unknown>,
  backend: TestDebtBackend,
): Promise<AskOutcome> {
  const claim = readClaim(await backend.claim(cwd, kind, key));
  if (!claim) throw new Error("The app's answer about that test couldn't be read. Nothing was asked.");
  if (!claim.claimed) return { kind, test, asked: false, note: claim.note };
  let asked: unknown;
  try {
    asked = await ask({ key: claim.key, question: claim.question, options: claim.options, recommended: claim.recommended });
  } catch (error) {
    await backend.release(cwd, kind, key).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
  const answer = alreadyAnswered(asked);
  if (answer && kind === "proposal") await backend.answer(cwd, key, answer).catch(() => undefined);
  return {
    kind,
    test,
    asked: true,
    note: answer
      ? `The person already answered "${answer}". ${claim.note}`
      : claim.note,
  };
}

/**
 * Files what the ship check says is due, one after the other (each claim is its own, so a retry or a second window asks nothing
 * twice). One that can't be filed says why and comes back with the next ship check.
 */
export async function fileTestDebtAsks(
  cwd: string,
  follow: TestDebtFollow,
  ask: (input: Record<string, unknown>) => Promise<unknown>,
  backend: TestDebtBackend = tauriTestDebt,
): Promise<AskOutcome[]> {
  const out: AskOutcome[] = [];
  for (const bug of follow.bugs) {
    try {
      out.push(await fileOne(cwd, "bug", bug.key, bug.test, ask, backend));
    } catch (error) {
      out.push({
        kind: "bug",
        test: bug.test,
        asked: false,
        note: `Couldn't ask about ${bug.test} this time (${error instanceof Error ? error.message : String(error)}). The next ship check will ask again.`,
      });
    }
  }
  for (const proposal of follow.proposals) {
    try {
      out.push(await fileOne(cwd, "proposal", proposal.id, proposal.test, ask, backend));
    } catch (error) {
      out.push({
        kind: "proposal",
        test: proposal.test,
        asked: false,
        note: `Couldn't ask about ${proposal.test} this time (${error instanceof Error ? error.message : String(error)}). The next ship check will ask again.`,
      });
    }
  }
  return out;
}
