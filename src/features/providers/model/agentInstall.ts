import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { HarnessId } from "../../sessions/model/session";
import { probeHarnessAvailability } from "../../../integrations/harness/core/availability";

/**
 * Installing an agent CLI from Settings > Providers > Agent CLIs. The command for each tool lives in Rust
 * (src-tauri/src/agent_install.rs); the webview only names the tool. Tools the app can't install by itself get their
 * install page instead.
 */

/** Tools the app installs itself (the same list as `install_command` in agent_install.rs). */
const INSTALLABLE: ReadonlySet<HarnessId> = new Set<HarnessId>([
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "omp",
  "devin",
]);

/** Install pages for the tools the app sends to their own site. */
const INSTALL_PAGE: Partial<Record<HarnessId, string>> = {
  fx: "https://fx.sh",
  hermes: "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
  antigravity: "https://antigravity.google/download",
};

/** What to run in a terminal to sign in, and what to do once it is open. */
const SIGN_IN: Partial<Record<HarnessId, { command: string; then?: string }>> = {
  claude: { command: "claude", then: "then type /login" },
  codex: { command: "codex login" },
  cursor: { command: "cursor-agent login" },
  grok: { command: "grok", then: "then finish signing in in the browser" },
  opencode: { command: "opencode auth login" },
  pi: { command: "pi", then: "then type /login" },
  omp: { command: "omp", then: "then type /login" },
  devin: { command: "devin auth login" },
};

export function canInstallAgent(harness: HarnessId): boolean {
  return INSTALLABLE.has(harness);
}

export function agentInstallPage(harness: HarnessId): string | undefined {
  return INSTALL_PAGE[harness];
}

export function agentSignIn(
  harness: HarnessId,
): { command: string; then?: string } | undefined {
  return SIGN_IN[harness];
}

export type AgentInstallState = {
  status: "running" | "installed" | "failed" | "cancelled";
  /** The last lines of output, newest last. */
  lines: string[];
  error?: string;
};

const KEEP_LINES = 12;
const states = new Map<HarnessId, AgentInstallState>();
const listeners = new Set<() => void>();
let listening: Promise<unknown> | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function update(harness: HarnessId, patch: Partial<AgentInstallState>) {
  const previous = states.get(harness) ?? { status: "running", lines: [] };
  states.set(harness, { ...previous, ...patch });
  emit();
}

function listenOnce(): Promise<unknown> {
  listening ??= listen<{ harness: HarnessId; line: string }>(
    "agent-install",
    ({ payload }) => {
      const current = states.get(payload.harness);
      if (!current || current.status !== "running") return;
      update(payload.harness, {
        lines: [...current.lines, payload.line].slice(-KEEP_LINES),
      });
    },
  ).catch((error: unknown) => {
    listening = null;
    throw error;
  });
  return listening;
}

export async function installAgent(harness: HarnessId): Promise<void> {
  if (states.get(harness)?.status === "running") return;
  states.set(harness, { status: "running", lines: [] });
  emit();
  try {
    await listenOnce();
    const result = await invoke<{ exitCode: number | null; cancelled: boolean }>(
      "agent_cli_install",
      { harness },
    );
    if (result.cancelled) {
      update(harness, { status: "cancelled" });
      return;
    }
    if (result.exitCode !== 0) {
      update(harness, {
        status: "failed",
        error: `The installer stopped with code ${result.exitCode ?? "unknown"}.`,
      });
      return;
    }
    // The row flips to installed once the probe finds the new binary.
    await probeHarnessAvailability({ force: true });
    update(harness, { status: "installed" });
  } catch (error) {
    update(harness, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function cancelAgentInstall(harness: HarnessId): void {
  void invoke("agent_cli_install_cancel", { harness }).catch(() => undefined);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentInstall(harness: HarnessId): AgentInstallState | undefined {
  return useSyncExternalStore(subscribe, () => states.get(harness));
}
