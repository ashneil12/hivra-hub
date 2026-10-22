import { createRoot } from "react-dom/client";
import { addMono, findMono } from "../../src/features/monos/model/mono";
import { MonoRailSection } from "../../src/app/shell/MonoRailSection";
import "../../src/styles/index.css";

// Round 27b proof fixture (browser preview, not Ash's Mac; made-up data labelled Example:): the real Monos rail with one
// Lead whose last turn failed on credits (only Ash can fix it: the red Needs you, the reason and Open <Lead>'s chat), one
// whose model is overloaded (a grey Can't answer), and two Monos waiting for Ash's OK whose OK hit a problem: one file
// that couldn't be read and was left as it is (grey), one OK that failed outright (the red Needs you).

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (command: string, args: unknown) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "plugin:event|unlisten") return;
      const ledger = JSON.stringify(args ?? {}).includes("ex-ledger");
      if (command === "mono_read") {
        if (ledger) throw new Error("Example: permission denied");
        return { text: null, hash: "" };
      }
      if (command === "mono_save") throw new Error("Example: the disk is full");
      return null;
    },
  },
});

const mono = (id: string, name: string, color: string) =>
  findMono(id) ?? addMono({ id, name, mascot: "robot", color, projects: [], sessionId: `${id}-chat` });
mono("ex-hivra-lead", "Example: Hivra lead", "hsl(160 60% 50%)");
mono("ex-nibbii-lead", "Example: Nibbii lead", "hsl(280 60% 65%)");
mono("ex-alfred", "Example: Alfred", "hsl(30 70% 60%)");
localStorage.setItem(
  "monocode:hub-souls-waiting",
  JSON.stringify([
    { monoId: "ex-ledger", name: "Example: Ledger", rules: "Example: soul", projects: [] },
    { monoId: "ex-scout", name: "Example: Scout", rules: "Example: soul", projects: [] },
  ]),
);

const states = new Map([
  ["ex-hivra-lead", { status: "failed" as const, activity: "Out of credits", tone: "red" as const, detail: "Example: 402 Insufficient credits" }],
  ["ex-nibbii-lead", { status: "failed" as const, activity: "The model is overloaded", tone: "amber" as const }],
  ["ex-alfred", { status: "idle" as const }],
]);

function App() {
  return (
    <div className="flex h-full">
      <aside className="h-full w-[260px] overflow-auto border-r border-content/10 bg-background-sidebar py-2" data-proof-rail>
        <MonoRailSection states={states as never} onOpen={(id) => document.body.setAttribute("data-opened", id)} onCreate={() => {}} onDelete={() => {}} rank={() => 0} />
      </aside>
      <main className="flex-1" />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
