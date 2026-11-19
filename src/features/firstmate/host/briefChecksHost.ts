// SC-4: the three app calls behind a brief's check lines, stamp and do-not-touch list (src-tauri/src/firstmate/
// brief_checks.rs). The model side is firstmate/model/briefChecks.ts; delegationTasks.ts hands these to the delegate tool.
import { invoke } from "@tauri-apps/api/core";
import { loadTestingMode, type TestingMode } from "../../delivery/model/testingMode";
import { validStamp, type CheckLine } from "../model/briefChecks";
import type { SpecPart } from "../model/briefSpec"; // PT-6

/** The project's testing mode, or undefined when the app can't say: a read that fails never refuses a brief. */
export async function testingModeOf(project: string): Promise<TestingMode | undefined> {
  try {
    return (await loadTestingMode(project)).mode;
  } catch {
    return undefined;
  }
}

/** The HEAD of the project's main checkout, or undefined (no git project, or git can't say): no stamp is made up. */
export async function briefStampOf(folder: string): Promise<string | undefined> {
  try {
    return validStamp(await invoke<string | null>("firstmate_brief_stamp", { folder }));
  } catch {
    return undefined;
  }
}

/**
 * Keeps a started task's lines, stamp and list on its row. The first keep wins, so a retry never blanks a result the
 * gates wrote. Nothing here can say a line passed: the app's command takes no result and refuses one.
 */
export function keepBriefOnRow(
  id: string,
  brief: { stamp?: string; checks: readonly CheckLine[]; leave: readonly string[]; spec?: readonly SpecPart[] },
): Promise<unknown> {
  return invoke("firstmate_brief_keep", {
    id,
    input: {
      ...(brief.stamp ? { stamp: brief.stamp } : {}),
      checks: brief.checks,
      leave: brief.leave,
      // PT-6: the spec parts the done check holds the worker's copy to.
      ...(brief.spec?.length ? { spec: brief.spec } : {}),
    },
  });
}
