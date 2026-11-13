// PT-6: the two reads behind a brief's spec of record (src-tauri/src/firstmate/spec_record.rs). The model side is
// firstmate/model/briefSpec.ts, which reads what comes back defensively; delegationTasks.ts hands these to the delegate tool.
import { invoke } from "@tauri-apps/api/core";
import type { SpecPart } from "../model/briefSpec";

/**
 * The current text of each section a brief touches, and (for a brief with no spec part) the spec files whose `paths:` cover its
 * scope, read from the project's main checkout. Reads only. The answer is untyped on purpose: `readSpecContext` checks it.
 */
export function specContextOf(folder: string, request: { parts: readonly SpecPart[]; scope: readonly string[] }): Promise<unknown> {
  return invoke("firstmate_spec_context", { folder, input: { deltas: request.parts, scope: request.scope } });
}

/** The project's landed tasks, newest first (the delegation rows of workers that finished and passed). Reads only. */
export function specLandedOf(project: string): Promise<unknown> {
  return invoke("firstmate_spec_landed", { project });
}
