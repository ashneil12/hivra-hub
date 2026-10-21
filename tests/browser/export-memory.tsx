// Round 21 fixture (browser proof only): Settings > Export and import as it opens, with a faked Tauri bridge that lists
// two made-up memory folders ("Example:" in their names). The Memory box starts ticked.
import { installFakeTauri } from "./fakeTauri";
import "../../src/styles/index.css";

installFakeTauri("main", (command) => {
  if (command === "portable_info")
    return { memoryRoot: "/Users/example/agent-memory", dev: false, memory: [
      { name: "example-global", files: 6, bytes: 20_000, history: true, global: true },
      { name: "example-game", files: 4, bytes: 12_000, history: true, global: false },
    ] };
  return null;
});

const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { PortablePage } = await import("../../src/features/portable/ui/PortablePage");
createRoot(document.getElementById("root")!).render(createElement("div", { className: "text-content" }, createElement(PortablePage)));
