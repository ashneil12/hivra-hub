// PT-5: the one quiet line beside the ship check card on a project's crew tab. It says how many tests wait to be sorted at ship, and
// "More" opens a popover that lists them: the test, its file, since when, and the task it came from. Real bugs and flaky tests are
// listed with a quiet label and are not counted. Nothing shows when the count is zero or the answer can't be read.
//
// A late answer never lands on another project, and a read that was overtaken by a newer one is dropped.
import { useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../../inbox/model/githubTasks";
import { Popover } from "../../../shared/ui/Popover";
import {
  loadTestDebt,
  subscribeTestDebt,
  tauriTestDebt,
  testDebtLine,
  type TestDebtBackend,
  type TestDebtItem,
  type TestDebtState,
  type TestDebtSummary,
} from "../model/testDebt";

const STATE_LABEL: Partial<Record<TestDebtState, string>> = { "real-bug": "Real bug", flaky: "Flaky" };

function ago(since: number): string {
  return formatRelativeTime(new Date(since).toISOString());
}

function Row({ item }: { item: TestDebtItem }) {
  const label = STATE_LABEL[item.state];
  return (
    <li className="rounded-md px-2 py-1.5" data-test-debt-item={item.state}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] text-content" data-test-debt-test>
          {item.test}
        </span>
        {label ? (
          <span className="shrink-0 text-[11px] text-content/55" data-test-debt-state>
            {label}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-content/60">
        {item.file ? <span data-test-debt-file>{item.file}</span> : null}
        <span data-test-debt-since>since {ago(item.since)}</span>
        {item.task ? <span data-test-debt-task>from {item.task}</span> : null}
      </p>
    </li>
  );
}

export function TestDebtLine({ project, backend = tauriTestDebt }: { project: string; backend?: TestDebtBackend }) {
  const folder = project.trim();
  const [summary, setSummary] = useState<TestDebtSummary | null>(null);
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // Every read takes a number; an answer whose number is no longer the latest is dropped. Leaving the project drops them all.
  const latest = useRef(0);

  useEffect(() => {
    setSummary(null);
    setOpen(false);
    if (!folder) return;
    const read = () => {
      const mine = ++latest.current;
      void loadTestDebt(folder, backend).then((next) => {
        if (mine === latest.current) setSummary(next);
      });
    };
    read();
    const stop = subscribeTestDebt(folder, read);
    return () => {
      stop();
      latest.current += 1;
    };
  }, [folder, backend]);

  if (!summary) return null;
  // The count is the app's own (the list may hold more tests than the popover shows), so "Sorting N tests" says all of them.
  const line = testDebtLine(summary.count, summary.sorting, summary.count);
  if (!line) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-stroke px-3 py-1.5" data-test-debt-line="">
      <p
        className="min-w-0 text-[12px] text-content/60"
        data-test-debt-count={summary.count}
        data-test-debt-sorting={summary.sorting ? "" : undefined}
      >
        {line}
      </p>
      <button
        ref={moreRef}
        type="button"
        data-test-debt-more=""
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-content/60 hover:bg-content/8 hover:text-content focus-visible:outline-2 focus-visible:outline-accent"
      >
        More
      </button>
      {open ? (
        <Popover
          anchor={moreRef}
          side="bottom"
          align="end"
          width={340}
          role="dialog"
          aria-label="Tests to sort at ship"
          autoFocus
          onDismiss={() => setOpen(false)}
          className="flex flex-col gap-1 overflow-y-auto p-2"
          data-test-debt-popover=""
        >
          <p className="px-2 pt-0.5 text-[12px] text-content/60">
            Real bugs and flaky tests are listed here and not counted.
          </p>
          {summary.items.length ? (
            <ul className="flex flex-col gap-0.5" data-test-debt-list="">
              {summary.items.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <p className="px-2 py-1 text-[12px] text-content/60">No tests are listed yet.</p>
          )}
        </Popover>
      ) : null}
    </div>
  );
}
