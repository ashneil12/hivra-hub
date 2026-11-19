// Autopilot as a project's mode (Dropwave, 11 Nov): one switch on each project's home, scoped to that project only, so
// its work never moves to another project. On Home the switch covers everything. It writes the app's own Autopilot
// switches (autopilot.ts); with no backend (a browser preview) it keeps the switch in this window only.
import { useSyncExternalStore } from "react";
import {
  EVERYTHING,
  activeSwitches,
  adoptStatus,
  autopilotBackend,
  autopilotSnapshot,
  useAutopilotVersion,
} from "../../autopilot/model/autopilot";

/** On until switched off: the switch is a mode, not a timer. */
const FOREVER_MS = Date.UTC(2100, 0, 1);

const preview = new Map<string, boolean>();
let previewVersion = 0;
const previewListeners = new Set<() => void>();

function scopeOf(projectId: string | undefined): string {
  return projectId && projectId.trim() ? projectId : EVERYTHING;
}

export function projectAutopilotOn(projectId: string | undefined, now = Date.now()): boolean {
  const scope = scopeOf(projectId);
  if (!autopilotBackend()) return preview.get(scope) ?? true;
  return activeSwitches(autopilotSnapshot(), now).some((sw) => sw.scope === scope || sw.scope === EVERYTHING);
}

export async function setProjectAutopilot(projectId: string | undefined, on: boolean): Promise<void> {
  const scope = scopeOf(projectId);
  const backend = autopilotBackend();
  if (!backend) {
    preview.set(scope, on);
    previewVersion += 1;
    previewListeners.forEach((listener) => listener());
    return;
  }
  const next = on
    ? await backend.set({ scopes: [scope], untilMs: FOREVER_MS, by: "ash", said: "Autopilot switch on the project's home" })
    : await backend.off({ scopes: [scope], by: "ash", said: "Autopilot switch on the project's home" });
  adoptStatus(next);
}

/** Re-renders when either the app's switches or the preview's change. */
export function useProjectAutopilotVersion(): number {
  const app = useAutopilotVersion();
  const local = useSyncExternalStore(
    (listener) => {
      previewListeners.add(listener);
      return () => previewListeners.delete(listener);
    },
    () => previewVersion,
    () => previewVersion,
  );
  return app + local;
}
