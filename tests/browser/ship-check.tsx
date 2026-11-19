// SC-3b: the ship check card on a project's crew tab, with the app's answers stubbed. Example data only.
//   ?state=none     no record yet (a project that tests at ship)
//   ?state=passed   a passed check
//   ?state=failed   a failed check (the button runs it again and it passes)
import { createRoot } from "react-dom/client";
import { ShipCheckCard } from "../../src/features/hub/ui/ShipCheckCard";
import type { ShipCheckBackend, ShipCheckRecord } from "../../src/features/hub/model/shipCheck";
import "../../src/styles/index.css";

const state = new URLSearchParams(window.location.search).get("state") ?? "none";
const at = Date.now() - 5 * 60_000;
const passed: ShipCheckRecord = {
  project: "/work/app",
  head: "3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a",
  base: "9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c",
  commitsCovered: 7,
  at,
  outcome: "passed",
  note: null,
  steps: [],
  tested: [
    "Example: the project's checks for src (npm test: 214 tests passed).",
    "Example: the real-app recipe, because a screen file changed.",
    "Example: the test guard over 7 commits: no test was weakened or removed.",
    "Example: a review of the change against 4 task briefs.",
  ],
  notTested: ["Example: docs changed; the project declares no check for docs."],
};
const failed: ShipCheckRecord = {
  ...passed,
  outcome: "failed",
  tested: ["Example: the project's checks for src (npm test: 2 of 214 failed)."],
  notTested: ["Example: the review did not run because a check failed first."],
};
let current: ShipCheckRecord | null = state === "passed" ? passed : state === "failed" ? failed : null;
const calls: string[] = [];

const backend: ShipCheckBackend = {
  run: async () => {
    calls.push("run");
    await new Promise((resolve) => setTimeout(resolve, 300));
    current = { ...passed, at: Date.now() };
    return current;
  },
  latest: async () => current,
  passed: async () => current?.outcome === "passed",
  head: async () => passed.head,
};

Object.assign(window, { __shipCheckCalls: calls });

createRoot(document.getElementById("root")!).render(
  <div className="max-w-xl p-6 text-content">
    <ShipCheckCard project="/work/app" backend={backend} loadMode={async () => ({ mode: "at-ship" })} />
  </div>,
);
