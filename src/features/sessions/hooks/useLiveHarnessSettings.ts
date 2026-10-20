import { useEffect, useRef } from "react";
import { applyHarnessSettings } from "../../../integrations/harness/core/registry";
import type { Session } from "../model/session";

type Watched = Pick<
  Session,
  "id" | "harness" | "model" | "modelSettings" | "runtimeMode" | "busy"
>;

function settingsKey(session: Watched): string {
  const settings = Object.entries(session.modelSettings ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify([
    session.harness,
    session.model,
    settings,
    session.runtimeMode,
  ]);
}

/**
 * Sessions whose model, settings or permission mode changed while a turn was
 * running, given the keys seen last time (updated in place). A change made
 * while idle needs nothing here: the next message starts with it.
 */
export function liveSettingsChanges(
  seen: Map<string, string>,
  sessions: readonly Watched[],
): Watched[] {
  const changed: Watched[] = [];
  const present = new Set<string>();
  for (const session of sessions) {
    present.add(session.id);
    const key = settingsKey(session);
    const before = seen.get(session.id);
    seen.set(session.id, key);
    if (before !== undefined && before !== key && session.busy) {
      changed.push(session);
    }
  }
  for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
  return changed;
}

/**
 * Hands a running session its new model, effort or permission mode now:
 * autopilot switching a busy Lead to full access, or the picker mid-turn.
 * It watches the sessions themselves, so every path that changes them counts.
 */
export function useLiveHarnessSettings(sessions: readonly Session[]): void {
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    for (const session of liveSettingsChanges(seen.current, sessions)) {
      void applyHarnessSettings({
        harness: session.harness,
        sessionId: session.id,
        model: session.model,
        modelSettings: session.modelSettings,
        runtimeMode: session.runtimeMode,
      }).catch(() => undefined);
    }
  }, [sessions]);
}
