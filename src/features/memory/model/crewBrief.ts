// WP-51: the crew's signed-in CLI, briefed as a cheap plan. No key is read or stored.

import { canRunHarnessTextPrompt, runHarnessTextPrompt } from "../../../integrations/harness";
import { homeDir } from "../../../platform/tauri/fs";
import { crewRouteFor } from "../../crew/model/host";
import { briefSignedIn, type BriefDeps } from "./signedInAsk";
import type { CuratorAsk } from "./curator";

const BRIEF_TIMEOUT_MS = 180_000;

export function crewMemoryBrief(): BriefDeps {
  return {
    route: () => crewRouteFor({ labels: ["memory"], paths: [] }),
    canRun: canRunHarnessTextPrompt,
    run: async ({ harness, model, prompt }) =>
      runHarnessTextPrompt({
        harness,
        cwd: await homeDir(),
        prompt,
        ...(model ? { model } : {}),
        intent: "plan",
        timeoutMs: BRIEF_TIMEOUT_MS,
      }),
  };
}

export function askCrew(prompt: string): Promise<CuratorAsk> {
  return briefSignedIn(prompt, crewMemoryBrief());
}
