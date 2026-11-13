// PT-5: the test debt line beside the ship check card, with the app's answers stubbed. Example data only.
//   ?state=none      nothing waits to be sorted (no line)
//   ?state=one       one test to sort
//   ?state=three     three tests to sort
//   ?state=mixed     two to sort, plus a real bug and a flaky test (listed, not counted)
//   ?state=sorting   the app is sorting two tests
//   ?state=garbage   an answer that can't be read (no line)
import { createRoot } from "react-dom/client";
import { TestDebtLine } from "../../src/features/hub/ui/TestDebtLine";
import type { TestDebtBackend, TestDebtItem } from "../../src/features/hub/model/testDebt";
import "../../src/styles/index.css";

const state = new URLSearchParams(window.location.search).get("state") ?? "none";
const twoDaysAgo = Date.now() - 2 * 86_400_000;

function example(id: string, over: Partial<TestDebtItem> = {}): TestDebtItem {
  return {
    id,
    test: `Example: saves the draft (${id})`,
    file: "src/draft/save.test.ts",
    since: twoDaysAgo,
    task: "Example: draft saving",
    state: "to-sort",
    ...over,
  };
}

const answers: Record<string, unknown> = {
  none: { count: 0, sorting: false, items: [] },
  one: { count: 1, sorting: false, items: [example("a")] },
  three: { count: 3, sorting: false, items: [example("a"), example("b"), example("c")] },
  mixed: {
    count: 2,
    sorting: false,
    items: [
      example("a"),
      example("b"),
      example("c", { state: "real-bug", test: "Example: adds a row", file: "src/rows/add.test.ts" }),
      example("d", { state: "flaky", test: "Example: loads the list", file: "src/list/load.test.ts" }),
    ],
  },
  sorting: { count: 2, sorting: true, items: [example("a"), example("b")] },
  garbage: { count: "lots", sorting: "maybe", items: "not a list" },
};

const calls: string[] = [];
const backend: TestDebtBackend = {
  summary: async (cwd) => {
    calls.push(cwd);
    return answers[state] ?? null;
  },
};

Object.assign(window, { __testDebtCalls: calls });

createRoot(document.getElementById("root")!).render(
  <div className="max-w-xl p-6 text-content">
    <TestDebtLine project="/work/app" backend={backend} />
  </div>,
);
