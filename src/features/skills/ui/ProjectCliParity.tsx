// WP-126: load the per-CLI report for the project open in Settings.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { acceptLoadedReport, readFailureNotice, type ParityReport } from "../model/cliParity";
import { loadProjectCliParity } from "../model/cliParityFs";
import { CliParityPanel } from "./CliParityPanel";

export function ProjectCliParity({ cwd }: { cwd: string }): ReactNode {
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const [retry, setRetry] = useState(0);
  const [phase, setPhase] = useState<{ cwd: string; report: ParityReport | null; notice: string | null }>({
    cwd,
    report: null,
    notice: null,
  });

  useEffect(() => {
    if (!cwd || cwd === "~") return;
    const requested = cwd;
    let current = true;
    setPhase({ cwd: requested, report: null, notice: null });
    void loadProjectCliParity(requested)
      .then((report) => {
        if (!current) return;
        const accepted = acceptLoadedReport(requested, cwdRef.current, report);
        if (!accepted) return;
        setPhase({ cwd: requested, report: accepted, notice: null });
      })
      .catch((error: unknown) => {
        if (!current || !acceptLoadedReport(requested, cwdRef.current, true)) return;
        setPhase({ cwd: requested, report: null, notice: readFailureNotice(error) });
      });
    return () => {
      current = false;
    };
  }, [cwd, retry]);

  if (!cwd || cwd === "~") {
    return (
      <CliParityPanel report={null} notice="Open a project to see what each CLI loads." />
    );
  }
  const shown = phase.cwd === cwd ? phase : { report: null, notice: null };
  return (
    <CliParityPanel
      report={shown.report}
      notice={shown.notice}
      onRetry={shown.notice ? () => setRetry((value) => value + 1) : undefined}
    />
  );
}
