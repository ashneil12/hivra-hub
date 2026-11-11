// WP-104: the real copy button, with a planted key and home path in the log it reads.

import { createRoot } from "react-dom/client";
import { DiagnosticsCopy } from "../../src/features/diagnostics/ui/DiagnosticsPanel";
import "../../src/styles/index.css";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const HOME = "/Users/ada";

createRoot(document.getElementById("root")!).render(
  <DiagnosticsCopy
    load={async () => ({
      version: "9.9.9",
      build: "test",
      os: "test os",
      home: HOME,
      lines: [`wrote ${HOME}/Library/logs then ${KEY}`],
      crashes: [],
      health: [],
    })}
    copy={async (text) => {
      const slot = document.querySelector("[data-copied]");
      if (slot) slot.textContent = text;
    }}
  />,
);
