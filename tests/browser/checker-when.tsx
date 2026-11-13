// PT-4: Settings > Crew > "When the checker runs", with the app's answers stubbed. The stub keeps the one rule in the page, like the
// app's database, and records each call so the spec can read what the control asked it to write.
//   ?fail=1      The first write is refused, so the control has to show what is stored and say it didn't save.
//   ?stored=<w>  What the app already has saved (a rule word), instead of nothing.
import { createRoot } from "react-dom/client";
import { CheckerWhenSetting } from "../../src/features/settings/ui/CheckerWhenSetting";
import "../../src/styles/index.css";

const params = new URLSearchParams(window.location.search);
const calls: { command: string; args: unknown }[] = [];
let stored = params.get("stored") ?? "follow-mode";
let failOnce = params.has("fail");

Object.assign(window, {
  __checkerCalls: calls,
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string, args?: unknown) => {
      if (command === "plugin:event|listen") return 0;
      calls.push({ command, args });
      if (command === "checker_when_rule_get") return stored;
      if (command === "checker_when_rule_set") {
        if (failOnce) {
          failOnce = false;
          throw "The database is busy.";
        }
        stored = String((args as { rule?: string } | undefined)?.rule ?? stored);
        return stored;
      }
      return null;
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <div className="max-w-xl p-6 text-content">
    <CheckerWhenSetting />
  </div>,
);
