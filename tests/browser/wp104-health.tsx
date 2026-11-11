// WP-104: the real health list and copy button. One loader stays put, so the list does not restart itself.
// A second list holds its first check, then a later check wins, and the late one must not overwrite it.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DiagnosticsPanel } from "../../src/features/diagnostics/ui/DiagnosticsPanel";
import { HealthList, useHealth } from "../../src/features/diagnostics/ui/HealthList";
import type { HealthFacts } from "../../src/features/diagnostics/model/health";
import "../../src/styles/index.css";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const HOME = "/Users/ada";
const NOW = Date.parse("2026-11-09T12:00:00Z");

const shown: HealthFacts = {
  clis: [{ id: "claude", name: `Claude ${HOME}/Library ${KEY}`, installed: false, signedIn: null }],
  git: { state: "ok", version: "git version 2.39.2" },
  diskFreeBytes: 1024,
  database: "problem",
  dataWritable: true,
  plugins: "missing",
  lastBackupAt: null,
  now: NOW,
  gateway: { name: "Ollama", state: "down" },
};

const settled: HealthFacts = {
  clis: [],
  git: { state: "ok", version: "git version 2.39.2" },
  diskFreeBytes: 3 * 1024 * 1024 * 1024,
  database: "ok",
  dataWritable: true,
  plugins: "readable",
  lastBackupAt: null,
  now: NOW,
  gateway: null,
};

const lateProblem: HealthFacts = {
  ...settled,
  clis: [{ id: "claude", name: "Claude Code", installed: false, signedIn: null }],
  database: "problem",
};

function loadShown(): Promise<HealthFacts> {
  return Promise.resolve(shown);
}

function loadReport() {
  return Promise.resolve({
    version: "9.9.9",
    build: "test",
    os: "test os",
    home: HOME,
    lines: [] as string[],
    crashes: [] as string[],
    health: [] as string[],
  });
}

async function copyText(text: string): Promise<void> {
  const slot = document.querySelector("[data-copied]");
  if (slot) slot.textContent = text;
}

let releaseLate: ((facts: HealthFacts) => void) | null = null;
let lateCalls = 0;

function loadLate(): Promise<HealthFacts> {
  lateCalls += 1;
  if (lateCalls === 1) {
    return new Promise((resolve) => {
      releaseLate = resolve;
    });
  }
  return Promise.resolve(settled);
}

function LateList() {
  const health = useHealth(loadLate, 400);
  const [released, setReleased] = useState(false);
  return (
    <div data-late>
      <HealthList rows={health.rows} pending={health.pending} note={health.note} />
      <button
        type="button"
        onClick={() => {
          if (released) return;
          setReleased(true);
          releaseLate?.(lateProblem);
        }}
      >
        Release the late check
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    <div data-health>
      <DiagnosticsPanel loadFacts={loadShown} loadReport={loadReport} copy={copyText} intervalMs={60_000} />
    </div>
    <LateList />
  </>,
);
