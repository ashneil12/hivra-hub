// Hivra WP-10: how each CLI keeps a first mate from editing the project.
//
// Two layers. Where a CLI can start read-only, a first mate's session does (`firstMate` on the launch input,
// integrations/harness/core/types.ts). For every CLI, whatever it supports, the app also snapshots the project's main
// checkout when a first-mate turn starts and checks it when the turn ends (src-tauri/src/firstmate/checkout_guard.rs):
// a change no landing explains flags the turn and is offered for revert. So a CLI with no read-only mode is still
// covered, just after the fact.
//
// This table is what the PR documents and what a UI can say about a first mate's CLI. Keep it in step with the
// providers: a row says "enforced" only when the launch code really applies it.
import type { HarnessId } from "../../sessions/model/session";

export type ReadOnlySupport = {
  /** `enforced`: the session starts without write access. `checked`: only the after-turn check. */
  level: "enforced" | "checked";
  /** How, in a line. */
  how: string;
  /** What is still possible and what catches it, or what a later package could add. */
  gap: string;
};

export const FIRST_MATE_READ_ONLY: Record<HarnessId, ReadOnlySupport> = {
  claude: {
    level: "enforced",
    how: "Started with Edit, Write, MultiEdit and NotebookEdit in --disallowedTools (deny rules hold in every permission mode, bypass included).",
    gap: "Bash stays, since a first mate reads git and calls the app's tools through it; a write made through Bash is caught by the after-turn check.",
  },
  codex: {
    level: "enforced",
    how: "Every thread and turn runs in Codex's read-only sandbox with approvals off (no escalation), network on for the delegate tool's loopback: the shape a plan turn already runs in.",
    gap: "MCP tools run outside the sandbox; the delegate tool writes only the app's own records.",
  },
  cursor: {
    level: "checked",
    how: "After-turn check only.",
    gap: "Its ACP permission requests could be answered read-only (allow read and search, deny the rest), as its plan turns already are; that needs the session in a mode that asks, not full access.",
  },
  grok: {
    level: "checked",
    how: "After-turn check only.",
    gap: "Same ACP permission gating as Cursor is possible (grok.ts already allows only read and search for plan turns).",
  },
  hermes: {
    level: "checked",
    how: "After-turn check only.",
    gap: "Same ACP permission gating as Cursor is possible (hermes.ts already does it for plan turns).",
  },
  devin: {
    level: "checked",
    how: "After-turn check only.",
    gap: "Devin's native plan mode plus client-side gating (devin.ts uses both for plan turns) could hold a first mate read-only.",
  },
  antigravity: {
    level: "checked",
    how: "After-turn check only.",
    gap: "No native plan mode; client-side denial of non-read permissions is possible, as its plan turns do.",
  },
  opencode: {
    level: "checked",
    how: "After-turn check only.",
    gap: "OpenCode's permission config (edit: deny) or its plan agent could hold it read-only; not wired yet.",
  },
  pi: {
    level: "checked",
    how: "After-turn check only.",
    gap: "Pi's RPC mode has no read-only switch the app drives.",
  },
  omp: {
    level: "checked",
    how: "After-turn check only.",
    gap: "omp's RPC mode has no read-only switch the app drives.",
  },
  fx: {
    level: "checked",
    how: "After-turn check only.",
    gap: "fx's ACP mode has no read-only switch the app drives.",
  },
};
