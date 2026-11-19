// WP-182: one activity row for a change on a Mono's card. Failures are swallowed.
import { findMono } from "./mono";

export function noteMonoSettings(monoId: string, summary: string): void {
  const name = findMono(monoId)?.name?.trim() || monoId;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke("activity_note", {
        kind: "mono.settings",
        summary,
        project: "app",
        target: monoId,
        actorId: monoId,
        actorName: name,
      }),
    )
    .catch(() => undefined);
}
