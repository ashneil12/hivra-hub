// WP-104: Settings → General. The button builds the report and copies it. The health list shares this panel.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildDiagnosticsReport, type DiagnosticsReportInput } from "../model/report";
import { HEALTH_REFRESH_MS, type HealthFacts } from "../model/health";
import { loadHealthFacts } from "../model/healthLoad";
import { HealthList, useHealth } from "./HealthList";

type Sources = {
  version: string;
  build: string;
  os: string;
  home: string;
  lines: string[];
  crashes: string[];
};

export function DiagnosticsCopy({
  load,
  copy,
  health = [],
}: {
  load: () => Promise<DiagnosticsReportInput>;
  copy: (text: string) => Promise<void>;
  health?: readonly string[];
}) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <section className="mt-8 flex flex-col gap-2">
      <h2 className="text-sm font-medium">Diagnostics</h2>
      <p className="text-sm text-content/70">
        Copy a short report to send when something goes wrong. It has the health list, the version, the recent log and
        any crash records. Keys are removed.
      </p>
      <button
        type="button"
        className="self-start rounded-md border border-content/15 px-2 py-1 text-sm disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setStatus("");
          void load()
            .then((input) =>
              copy(
                buildDiagnosticsReport({
                  ...input,
                  health: input.health.length > 0 ? input.health : health,
                }),
              ),
            )
            .then(() => setStatus("Copied. Paste it into a message."))
            .catch(() => setStatus("Couldn't copy that. Try again."))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Copying" : "Copy diagnostics"}
      </button>
      {status ? (
        <p className="text-sm" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

async function loadFromApp(): Promise<DiagnosticsReportInput> {
  const sources = await invoke<Sources>("diagnostics_sources");
  return {
    version: sources.version,
    build: sources.build,
    os: sources.os,
    home: sources.home,
    lines: sources.lines ?? [],
    crashes: sources.crashes ?? [],
    health: [],
  };
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function DiagnosticsPanel({
  loadFacts = loadHealthFacts,
  loadReport = loadFromApp,
  copy = copyToClipboard,
  intervalMs = HEALTH_REFRESH_MS,
}: {
  loadFacts?: () => Promise<HealthFacts>;
  loadReport?: () => Promise<DiagnosticsReportInput>;
  copy?: (text: string) => Promise<void>;
  intervalMs?: number;
} = {}) {
  const health = useHealth(loadFacts, intervalMs);
  return (
    <>
      <HealthList rows={health.rows} pending={health.pending} note={health.note} />
      <DiagnosticsCopy load={loadReport} copy={copy} health={health.lines} />
    </>
  );
}
