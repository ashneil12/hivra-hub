// Hivra WP-171: what the disk says about a contract once a provider is done.
//
// A task is not delivered to the tasks that wait on it until what it was to provide is really there. Every check here
// is plain on purpose: a file exists, a literal appears in a file, an `id="..."` attribute appears in the markup. That
// catches what the contract was written for (a symbol nobody exported, an id spelled two ways) and is all a text search
// can honestly claim. Whether the symbol has the right shape is what a task's declared check is for: it runs as the
// task's WP-40 checks gate, and a check that did not run is never a pass (fanoutWaves.ts reads the gate verdict).
//
// Translated to TypeScript from Atomic Agent's src/tools/fusion/contract-checks.ts (MIT, Copyright (c) 2026 Atomic Bot,
// commit 1b4e641525c5b1427b48ff6b8d9932dc26bd8256): contentProvides (a symbol as a whole word, an id as the attribute in
// either quote, anything else as the literal) and inspectContractProvides (each file read once, a missing file said as
// missing). Changed for Hivra:
// - A name nobody could look for, an unreadable folder or a failing reader FAILS (Atomic skips a provide it cannot search
//   and reports it separately): in Hivra a check that did not run is never a pass.
// - It runs when a provider finishes and before anything waiting on it starts, in the project the work landed in,
//   through a reader the app lends (the webview's own file commands); it never reads outside that folder.
// - The answer is kept per provider and row version, so a redone provider is checked again.
import { awaitsVerification, dependencyVerdict, parseFanoutLink, type DependencyLookup, type DependencyWait, type RowView, type Verification } from "./fanoutWaves";
import { provideSearchPaths, type Contract, type ContractProvide } from "./fanoutContract";
import type { QueuedWorker } from "../../monos/model/workerPool";

/** The files a check reads. The app lends it; a test lends a map. */
export type FileIo = {
  /** True when the path is a file. */
  exists(path: string): Promise<boolean>;
  /** The file's text, or null when it is not there or is not text. */
  read(path: string): Promise<string | null>;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `content` carries the provide. A symbol is matched as a whole word so `HD.Ship` does not pass on
 * `HD.Shipyard`; the boundaries are lookarounds because `\b` misreads names that start or end in `$`. An id is the
 * attribute, in either quote. Everything else is the literal.
 */
export function contentProvides(content: string, provide: Pick<ContractProvide, "kind" | "name">): boolean {
  const name = escapeRegExp(provide.name);
  if (provide.kind === "symbol") return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(content);
  if (provide.kind === "id") return new RegExp(`\\bid\\s*=\\s*(?:"${name}"|'${name}')`).test(content);
  return content.includes(provide.name);
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Check what `task` was to provide, in `folder` (the project the finished work landed in). Never throws: a path that
 * cannot be read counts as not providing, with the reason.
 */
export async function inspectProvides(task: string, contract: Contract, folder: string, io: FileIo): Promise<Verification> {
  const root = folder.replace(/[\\/]+$/, "");
  const at = (relative: string) => `${root}/${relative}`;
  const cache = new Map<string, Promise<string | null | Error>>();
  const read = (relative: string) => {
    let pending = cache.get(relative);
    if (!pending) {
      pending = io.read(at(relative)).catch((error: unknown) => (error instanceof Error ? error : new Error(reasonOf(error))));
      cache.set(relative, pending);
    }
    return pending;
  };
  const problems: string[] = [];
  for (const provide of contract.provides.filter((entry) => entry.task === task)) {
    const what = `${provide.kind} ${provide.name}`;
    try {
      if (provide.kind === "file") {
        if (!(await io.exists(at(provide.name)))) problems.push(`${what} does not exist`);
        continue;
      }
      const where = provideSearchPaths(provide, contract);
      if (!where.length) {
        problems.push(`${what} cannot be checked: there is no file to look in`);
        continue;
      }
      let found = false;
      let missing = 0;
      let failure: string | undefined;
      for (const path of where) {
        const content = await read(path);
        if (content instanceof Error) failure = content.message;
        else if (content === null) missing += 1;
        else if (contentProvides(content, provide)) {
          found = true;
          break;
        }
      }
      if (found) continue;
      if (failure) problems.push(`${what} could not be checked (${failure})`);
      else
        problems.push(
          `${what} is not in ${where.join(", ")}${missing === where.length ? (where.length === 1 ? " (that file is missing)" : " (those files are missing)") : ""}`,
        );
    } catch (error) {
      problems.push(`${what} could not be checked (${reasonOf(error)})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The answer for each provider, with the row version it was given for: a changed row is asked again, and so is a miss
 * once RECHECK_MS has passed (the files may have landed since).
 */
const verifications = new Map<string, { at: string; result: Verification; checkedAt: number }>();
export const RECHECK_MS = 20_000;
const versionOf = (row: RowView | undefined) => `${row?.version ?? ""}:${row?.updatedAt ?? ""}`;

/** What the check of a finished provider found, once it ran for this version of its row. */
export function verificationOf(session: string, row?: RowView): Verification | undefined {
  const known = verifications.get(session);
  if (!known || (row && known.at !== versionOf(row))) return undefined;
  return known.result;
}

/** For tests: no answers kept. */
export function forgetVerifications(): void {
  verifications.clear();
}

export type SettleDeps = {
  /** The rows this window has (open ones and recent ones). */
  row(session: string): RowView | undefined;
  /** A row from the store, for a provider this window does not have (after a restart). `owner` is the chat that asked for it. */
  fetchRow?(session: string, owner: string): Promise<RowView | undefined>;
  /** Hands a fetched row to whatever `row` reads, so the queue sees it. */
  keep?(session: string, row: RowView): void;
  /** The project folder the provider's work landed in, when its chat is known. */
  folder(session: string): string | undefined;
  io: FileIo;
  /** The clock a miss is timed on; tests pin it. */
  now?(): number;
};

/**
 * Before the queue decides who starts: for each waiting task of a fan-out, read its providers' rows (from the store when
 * this window lacks them) and check what each finished one made. A damaged link is skipped here and held by
 * `fanoutDependency`; a provider that is not finished is left until it is.
 */
export async function settleFanout(queue: readonly QueuedWorker[], deps: SettleDeps): Promise<void> {
  for (const job of queue) {
    const raw = job.input?.fanout;
    if (raw === undefined) continue;
    let link;
    try {
      link = parseFanoutLink(raw);
    } catch {
      continue;
    }
    for (const name of link.after) {
      const session = link.tasks[name].session;
      let row = deps.row(session);
      if (!row && deps.fetchRow) {
        row = await deps.fetchRow(session, job.ownerSession).catch(() => undefined);
        if (row) deps.keep?.(session, row);
      }
      if (!row || !awaitsVerification(link, name, row)) continue;
      const known = verifications.get(session);
      const now = (deps.now ?? Date.now)();
      if (known && known.at === versionOf(row) && (known.result.ok || now - known.checkedAt < RECHECK_MS)) continue;
      const folder = deps.folder(session);
      const result = folder
        ? await inspectProvides(name, link.contract, folder, deps.io)
        : { ok: false, problems: [`can't tell where ${name} worked, so what it provided can't be checked`] };
      verifications.set(session, { at: versionOf(row), result, checkedAt: now });
    }
  }
}

/**
 * The queue's `dependency` check: what a task of a fan-out still waits for, from the rows and the checks of what its
 * providers made. A plan record that cannot be read holds the task, never lets it through.
 */
export function fanoutDependency(
  lookup: DependencyLookup,
  now: () => number = Date.now,
): (job: { id: string; fanout: unknown }) => DependencyWait | undefined {
  return (job) => {
    let link;
    try {
      link = parseFanoutLink(job.fanout);
    } catch {
      return {
        reason: "held",
        line: "Held: this task's plan record is damaged, so it can't tell what it waits for. Cancel it with task_cancel (its childSessionId) and send it again.",
      };
    }
    return dependencyVerdict(link, lookup, now());
  };
}

