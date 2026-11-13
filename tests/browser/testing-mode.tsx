// SC-3a: Settings > Crew > "How tasks are tested", with the app's answers stubbed. The stub keeps one row per project in
// the page, like the app's database, and records each call so the spec can read what the control asked it to write.
//   ?home=1   Home is in view: a project picker comes first.
//   ?stale=1  Another window chooses Full just before the first write, so that write is refused.
import { createRoot } from "react-dom/client";
import { TestingModeSetting } from "../../src/features/delivery/ui/TestingModeSetting";
import "../../src/styles/index.css";

const STALE = "Those delivery settings changed in another window. Look again, then set them.";

type Row = { testingMode: string | null; updatedAt: number | null };

const params = new URLSearchParams(window.location.search);
const calls: { command: string; args: unknown }[] = [];
const rows = new Map<string, Row>();
let staleOnce = params.has("stale");

Object.assign(window, {
  __testingCalls: calls,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string, args?: unknown) => {
      if (command === "plugin:event|listen") return 0;
      calls.push({ command, args });
      const { project, mode, expectedUpdatedAt } = (args ?? {}) as {
        project: string;
        mode?: string;
        expectedUpdatedAt?: number | null;
      };
      const row = rows.get(project) ?? { testingMode: null, updatedAt: null };
      if (command === "delivery_settings_get") {
        return {
          project,
          testingMode: row.testingMode ?? "at-ship",
          testingDefaulted: row.testingMode === null,
          updatedAt: row.updatedAt,
        };
      }
      if (command === "delivery_testing_mode_set") {
        if (staleOnce) {
          staleOnce = false;
          rows.set(project, { testingMode: "full", updatedAt: 9 });
          throw STALE;
        }
        if (row.updatedAt !== (expectedUpdatedAt ?? null)) throw STALE;
        const next = { testingMode: mode ?? null, updatedAt: (row.updatedAt ?? 0) + 1 };
        rows.set(project, next);
        return { project, ...next };
      }
      return null;
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <div className="max-w-xl p-6 text-content">
    <TestingModeSetting
      project="/work/app"
      recents={[{ path: "/work/other" }, { path: "/work/app" }]}
      home={params.has("home")}
    />
  </div>,
);
