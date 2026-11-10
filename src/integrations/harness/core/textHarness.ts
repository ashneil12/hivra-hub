import type { HarnessId } from "../../../features/sessions/model/session";
import { isHarnessAvailable } from "./availability";
import type { PrContent } from "../../../features/source-control/model/gitText";
import {
  branchFromTextModel,
  commitFromTextModel,
  prFromTextModel,
  titleFromTextModel,
} from "./textGenerationRun";
import {
  generateHarnessBranchName,
  generateHarnessCommitMessage,
  generateHarnessPrContent,
  generateHarnessTitle,
  warmupHarnessText,
  type TitleInput,
} from "./registry";

const TEXT_HARNESSES: HarnessId[] = [
  "claude",
  "cursor",
  "codex",
  "grok",
  "opencode",
];

/** Pick the harness used for titles, commit messages, and PR text. */
export function pickTextHarness(preferred?: HarnessId): HarnessId {
  const ordered =
    preferred && TEXT_HARNESSES.includes(preferred)
      ? [preferred, ...TEXT_HARNESSES.filter((id) => id !== preferred)]
      : TEXT_HARNESSES;
  for (const id of ordered) {
    if (isHarnessAvailable(id)) return id;
  }
  return preferred && TEXT_HARNESSES.includes(preferred) ? preferred : "cursor";
}

export function warmupText(cwd: string, preferred?: HarnessId): Promise<void> {
  return warmupHarnessText(pickTextHarness(preferred), cwd);
}

export async function generateCommitMessage(
  cwd: string,
  preferred?: HarnessId,
  signal?: AbortSignal,
  paths?: readonly string[],
): Promise<string> {
  signal?.throwIfAborted();
  const fromText = await commitFromTextModel(cwd, signal, paths);
  if (fromText) return fromText;
  return generateHarnessCommitMessage(pickTextHarness(preferred), cwd, signal, paths);
}

export async function generatePrContent(
  cwd: string,
  preferred?: HarnessId,
): Promise<(PrContent & { base: string; head: string }) | null> {
  const fromText = await prFromTextModel(cwd);
  if (fromText) return fromText;
  return generateHarnessPrContent(pickTextHarness(preferred), cwd);
}

/** WP-129: the short text model, then the coding agent that already writes titles. */
export async function generateTitleWithTextModel(
  harness: HarnessId,
  input: TitleInput,
): Promise<Awaited<ReturnType<typeof generateHarnessTitle>>> {
  const fromText = await titleFromTextModel(input.message);
  if (fromText) return fromText;
  return generateHarnessTitle(harness, input);
}

/** WP-129: the short text model, then the coding agent that already names branches. */
export async function generateBranchWithTextModel(
  harness: HarnessId,
  cwd: string,
  message: string,
): Promise<string | null> {
  const fromText = await branchFromTextModel(message);
  if (fromText) return fromText;
  return generateHarnessBranchName(harness, cwd, message);
}
