// WP-182: a card edit made while a turn is running is applied once that turn is idle.
import { useEffect } from "react";
import { resolveModel } from "../../sessions/model/models";
import type { HarnessId } from "../../sessions/model/session";
import { applyIdleCardRuns, isCardHarness, queueCardRun, settingsForCard, type CardRun } from "../model/monoRun";

type Watched = { id: string; busy?: boolean; modelSettings?: Record<string, string> };

export function useApplyMonoCardRun(
  sessions: readonly Watched[],
  onModelChange: (sessionId: string, harness: HarnessId, model: string) => void | boolean,
  onModelSettingsChange: (sessionId: string, settings: Record<string, string>) => void,
): void {
  useEffect(() => {
    applyIdleCardRuns(sessions, (sessionId, run: CardRun) => {
      if (!isCardHarness(run.harness)) return;
      const current = sessions.find((session) => session.id === sessionId)?.modelSettings;
      // WP-182: a conflict or a handoff did not take the model. The run was already
      // dropped, so put it back while this session is still here. A session that
      // is gone is not queued again.
      if (onModelChange(sessionId, run.harness, run.model) === false) {
        if (sessions.some((session) => session.id === sessionId)) queueCardRun(run);
        return;
      }
      onModelSettingsChange(sessionId, settingsForCard(resolveModel(run.harness, run.model), { ...current, ...run.settings }, run.engineFast));
    });
  }, [sessions, onModelChange, onModelSettingsChange]);
}
