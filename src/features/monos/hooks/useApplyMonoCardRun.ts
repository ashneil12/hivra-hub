// WP-182: a card edit made while a turn is running is applied once that turn is idle.
import { useEffect } from "react";
import type { HarnessId } from "../../sessions/model/session";
import { applyIdleCardRuns, isCardHarness, type CardRun } from "../model/monoRun";

type Watched = { id: string; busy?: boolean };

export function useApplyMonoCardRun(
  sessions: readonly Watched[],
  onModelChange: (sessionId: string, harness: HarnessId, model: string) => void,
  onModelSettingsChange: (sessionId: string, settings: Record<string, string>) => void,
): void {
  useEffect(() => {
    applyIdleCardRuns(sessions, (sessionId, run: CardRun) => {
      if (!isCardHarness(run.harness)) return;
      onModelChange(sessionId, run.harness, run.model);
      onModelSettingsChange(sessionId, run.settings);
    });
  }, [sessions, onModelChange, onModelSettingsChange]);
}
