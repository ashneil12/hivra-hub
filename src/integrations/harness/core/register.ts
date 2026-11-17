import { ensureClaudeRegistered } from "../providers/claude/claudeAdapter";
import { ensureCodexRegistered } from "../providers/codex/codexAdapter";
import { ensureCursorRegistered } from "../providers/cursor/cursorAdapter";
import { ensureFxRegistered } from "../providers/fx/fxAdapter";
import { ensureGrokRegistered } from "../providers/grok/grokAdapter";
import { ensureHermesRegistered } from "../providers/hermes/hermesAdapter";
import { ensureOpenCodeRegistered } from "../providers/opencode/opencodeAdapter";
import { ensureOmpRegistered } from "../providers/omp/ompAdapter";
import { ensurePiRegistered } from "../providers/pi/piAdapter";
import { ensureAntigravityRegistered } from "../providers/antigravity/antigravityAdapter";
import { ensureDevinRegistered } from "../providers/devin/devinAdapter";
import { t3DevPageAdapters } from "../providers/t3/t3DevPage";
import { registerHarness } from "./registry";

/** Register all known live harness adapters. Idempotent. */
export function registerBuiltinHarnesses(): void {
  ensureClaudeRegistered();
  ensureCursorRegistered();
  ensureCodexRegistered();
  ensureGrokRegistered();
  ensureOpenCodeRegistered();
  ensurePiRegistered();
  ensureOmpRegistered();
  ensureFxRegistered();
  ensureHermesRegistered();
  ensureAntigravityRegistered();
  ensureDevinRegistered();
  // Dropwave on T3: a dev page that names a T3 engine in its address runs every chat through it instead.
  if (import.meta.env.DEV || import.meta.env.MODE === "mockup") t3DevPageAdapters().forEach(registerHarness);
}
