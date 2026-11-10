// WP-132b: ask the harness that already writes commit text. No new GitHub request.

import {
  canRunHarnessTextPrompt,
  runHarnessTextPrompt,
} from "../../../integrations/harness/core/registry";
import { pickTextHarness } from "../../../integrations/harness/core/textHarness";
import { REVIEW_GUIDE_TIMEOUT_MS, type GuideAsk } from "./reviewGuide";

export function reviewGuideAsk(cwd: string): GuideAsk | null {
  const root = cwd.trim();
  if (!root) return null;
  const harness = pickTextHarness();
  if (!canRunHarnessTextPrompt(harness)) return null;
  return (prompt, signal) =>
    runHarnessTextPrompt({
      harness,
      cwd: root,
      prompt,
      signal,
      timeoutMs: REVIEW_GUIDE_TIMEOUT_MS,
      ephemeral: true,
    });
}
