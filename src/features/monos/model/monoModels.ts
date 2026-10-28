// Ash (27 Oct): no Claude subscription anywhere. Every Mono and Lead names Grok 4.7 as its model, explicitly, and
// workers run on DeepSeek (taskDifficulty.ts). Before this, the team was noted only as "claude" (so it started on the
// app's default, Claude Sonnet 5) and the checker as claude:haiku: only labels on the subscription bridge, but a name
// the bridge's launcher didn't know could reach another provider (bridgeModels.ts). This moves them over once, through
// the roster's own save (MONOS.json included), and their chats through the app's own model change.
import { isClaudeAliasModel, MONO_BRIDGE_MODEL_ID } from "../../sessions/model/bridgeModels";
import { isProjectLeadId, listMonos, updateMono, type Mono } from "./mono";

/**
 * The engine fields a Mono should have, or undefined when it is fine: a Claude Code Mono (or a project's Lead, which
 * never had an engine noted) whose model is a Claude name or none moves to Grok 4.7. A Mono on another engine, or one
 * whose model Ash chose (Grok, DeepSeek, one of his own models), is left alone. Leads only: Ash's own Monos without an
 * engine keep the app's default.
 */
export function monoModelFix(mono: Pick<Mono, "id" | "engine" | "engineModel">): Pick<Mono, "engine" | "engineModel"> | undefined {
  const engine = mono.engine ?? (isProjectLeadId(mono.id) ? "claude" : undefined);
  if (engine !== "claude" || !isClaudeAliasModel(mono.engineModel)) return undefined;
  return { engine, engineModel: MONO_BRIDGE_MODEL_ID };
}

/** Moves every Mono that needs it (monoModelFix). Idempotent: a second run changes nothing. Returns the ids moved. */
export function migrateMonoModels(
  deps: { list?: () => Mono[]; update?: typeof updateMono } = {},
): string[] {
  const { list = listMonos, update = updateMono } = deps;
  const moved: string[] = [];
  for (const mono of list()) {
    const fix = monoModelFix(mono);
    if (!fix) continue;
    update(mono.id, (current) => ({ ...current, ...fix }));
    moved.push(mono.id);
  }
  return moved;
}

/**
 * The model a Mono's existing chat should move to, or undefined: only when the Mono names a model on the chat's own
 * engine and the chat is still on a Claude name (the old default). A model Ash picked in the chat is left alone.
 */
export function monoChatModelFix(
  mono: Pick<Mono, "engine" | "engineModel">,
  chat: { harness: string; model?: string },
): string | undefined {
  if (!mono.engine || !mono.engineModel || mono.engine !== chat.harness) return undefined;
  if (chat.model === mono.engineModel || !isClaudeAliasModel(chat.model)) return undefined;
  return mono.engineModel;
}
