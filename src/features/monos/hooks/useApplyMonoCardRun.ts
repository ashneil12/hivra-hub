// WP-182: a card edit made while a turn is running is applied once that turn is idle.
import { useEffect } from "react";
import { resolveModel } from "../../sessions/model/models";
import type { HarnessId } from "../../sessions/model/session";
import { applyIdleCardRuns, isCardHarness, settingsForCard, type CardRun } from "../model/monoRun";

type Watched = { id: string; busy?: boolean; modelSettings?: Record<string, string> };

export function useApplyMonoCardRun(
  sessions: readonly Watched[],
  onModelChange: (sessionId: string, harness: HarnessId, model: string) => void,
  onModelSettingsChange: (sessionId: string, settings: Record<string, string>) => void,
): void {
  useEffect(() => {
    applyIdleCardRuns(sessions, (sessionId, run: CardRun) => {
      if (!isCardHarness(run.harness)) return;
      const current = sessions.find((session) => session.id === sessionId)?.modelSettings;
      onModelChange(sessionId, run.harness, run.model);
      onModelSettingsChange(sessionId, settingsForCard(resolveModel(run.harness, run.model), { ...current, ...run.settings }, run.engineFast));
    });
  }, [sessions, onModelChange, onModelSettingsChange]);
}
