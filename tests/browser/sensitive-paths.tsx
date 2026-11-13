// Settings > Crew > "How tasks are tested", with the protected-paths line under the mode list. The app's answers are stubbed:
// the stub keeps one row per project in the page, like the app's database, and records each call.
import { createRoot } from "react-dom/client";
import { TestingModeSetting } from "../../src/features/delivery/ui/TestingModeSetting";
import "../../src/styles/index.css";

type Row = { testingMode: string | null; updatedAt: number | null };

const calls: { command: string; args: unknown }[] = [];
const rows = new Map<string, Row>();

Object.assign(window, {
  __sensitiveCalls: calls,
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
        if (row.updatedAt !== (expectedUpdatedAt ?? null)) throw "Those delivery settings changed in another window.";
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
    <TestingModeSetting project="/work/app" recents={[{ path: "/work/app" }]} home={false} />
  </div>,
);
