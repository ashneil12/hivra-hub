// WP-129: try the saved text model before the coding CLI. A miss, a bad reply or a timeout
// returns null so the caller can use today's path. Cancelling does not fall through.
// The ask carries no path, so this cannot write the repo.

import { listCustomModels } from "../../../features/sessions/model/customModels";
import {
  buildThreadTitlePrompt,
  parseGeneratedSessionTitle,
  type GeneratedSessionTitle,
} from "../../../features/sessions/model/sessionTitle";
import {
  askShortText,
  textGenerationPort,
  type SavedTextModel,
} from "../../../features/settings/model/textGenerationClient";
import { loadTextGeneration, type TextGenerationSetting } from "../../../features/settings/model/textGeneration";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  formatCommitMessage,
  parseBranchName,
  parseCommitMessage,
  parsePrContent,
  type PrContent,
} from "../../../features/source-control/model/gitText";
import { gitRangeContext, gitStagedContext } from "../../../platform/tauri/fs";

type Staged = { branch: string | null; summary: string; patch: string };
type Range = { base: string; head: string; commitSummary: string; diffSummary: string; diffPatch: string };

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function savedModels(): SavedTextModel[] {
  try {
    return listCustomModels().flatMap((model) => {
      if (typeof model?.id !== "string" || typeof model.provider !== "string") return [];
      if (typeof model.baseUrl !== "string" || typeof model.modelId !== "string") return [];
      return [{ id: model.id, provider: model.provider, baseUrl: model.baseUrl, modelId: model.modelId }];
    });
  } catch {
    return [];
  }
}

function asStaged(value: unknown): Staged | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.summary !== "string" || typeof row.patch !== "string") return null;
  if (row.branch != null && typeof row.branch !== "string") return null;
  return { branch: typeof row.branch === "string" ? row.branch : null, summary: row.summary, patch: row.patch };
}

function asRange(value: unknown): Range | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.base !== "string" || !row.base.trim()) return null;
  if (typeof row.head !== "string" || !row.head.trim()) return null;
  if (typeof row.commitSummary !== "string" || typeof row.diffSummary !== "string" || typeof row.diffPatch !== "string") {
    return null;
  }
  return {
    base: row.base,
    head: row.head,
    commitSummary: row.commitSummary,
    diffSummary: row.diffSummary,
    diffPatch: row.diffPatch,
  };
}

async function ask(setting: TextGenerationSetting, prompt: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await askShortText({ setting, prompt, models: savedModels(), port: textGenerationPort(), signal });
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

/** A commit message from the text model, or null when the coding CLI should try. */
export async function commitFromTextModel(
  cwd: string,
  signal?: AbortSignal,
  paths?: readonly string[],
): Promise<string | null> {
  signal?.throwIfAborted();
  const setting = loadTextGeneration();
  if (!setting) return null;
  try {
    signal?.throwIfAborted();
    const context = asStaged(await gitStagedContext(cwd, paths));
    if (!context) return null;
    signal?.throwIfAborted();
    const text = await ask(
      setting,
      buildCommitMessagePrompt({
        branch: context.branch,
        stagedSummary: context.summary,
        stagedPatch: context.patch,
      }),
      signal,
    );
    signal?.throwIfAborted();
    if (!text) return null;
    const parsed = parseCommitMessage(text);
    return parsed ? formatCommitMessage(parsed) : null;
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

/** Pull request text from the text model. Base and head always come from git, never from the model. */
export async function prFromTextModel(cwd: string): Promise<(PrContent & { base: string; head: string }) | null> {
  const setting = loadTextGeneration();
  if (!setting) return null;
  try {
    const range = asRange(await gitRangeContext(cwd));
    if (!range) return null;
    const text = await ask(
      setting,
      buildPrContentPrompt({
        baseBranch: range.base,
        headBranch: range.head,
        commitSummary: range.commitSummary,
        diffSummary: range.diffSummary,
        diffPatch: range.diffPatch,
      }),
    );
    if (!text) return null;
    const parsed = parsePrContent(text);
    if (!parsed) return null;
    return { title: parsed.title, body: parsed.body, base: range.base, head: range.head };
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

/** A sidebar title from the text model, or null when the coding CLI should try. */
export async function titleFromTextModel(message: string): Promise<GeneratedSessionTitle | null> {
  const setting = loadTextGeneration();
  if (!setting || typeof message !== "string" || !message.trim()) return null;
  try {
    const text = await ask(setting, buildThreadTitlePrompt(message));
    if (!text) return null;
    return parseGeneratedSessionTitle(text, message);
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

/** A branch fragment from the text model, or null when the coding CLI should try. The ask has no checkout path. */
export async function branchFromTextModel(message: string): Promise<string | null> {
  const setting = loadTextGeneration();
  if (!setting || typeof message !== "string" || !message.trim()) return null;
  try {
    const text = await ask(setting, buildBranchNamePrompt(message));
    if (!text) return null;
    return parseBranchName(text);
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}
