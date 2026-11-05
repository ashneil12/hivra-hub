// WP-51: the curator's model work, and an import that was not given a key, go through the crew.
// A signed-in CLI is briefed the way any other job is. A key is never read or stored here.

import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { roleModel, type Route } from "../../crew/model/resolve";
import { mentionsSecret } from "./doc";
import type { CuratorAsk } from "./curator";

export type BriefRun = {
  harness: HarnessId;
  model?: string;
  prompt: string;
};

export type BriefDeps = {
  route: () => Promise<Route>;
  run: (input: BriefRun) => Promise<string>;
  /** When set, a CLI that cannot take a text prompt is left unfinished. */
  canRun?: (harness: HarnessId) => boolean;
  /**
   * Present so a caller can prove a key stays untouched. This function never
   * calls either of them, including when the prompt holds a secret.
   */
  readKey?: () => Promise<unknown>;
  storeKey?: (key: string) => void;
};

function unfinished(error: unknown): CuratorAsk {
  const reason = error instanceof Error ? error.message : "The model didn't answer.";
  if (/timeout/i.test(reason)) return { ok: false, kind: "timeout", reason };
  return { ok: false, kind: "unreachable", reason };
}

function isHarness(cli: string): cli is HarnessId {
  return (HARNESSES as readonly string[]).includes(cli);
}

/** One brief. A secret never leaves this function. No signed-in CLI is unfinished, not a final no. */
export async function briefSignedIn(prompt: string, deps: BriefDeps): Promise<CuratorAsk> {
  if (mentionsSecret(prompt)) {
    return { ok: false, kind: "refused", reason: "That chat contained a secret, so it was not sent." };
  }
  let routed: Route;
  try {
    routed = await deps.route();
  } catch (error) {
    return unfinished(error);
  }
  const cli = routed.cli;
  if (!cli || !isHarness(cli)) {
    return { ok: false, kind: "unreachable", reason: "No signed-in CLI yet. It can be tried again." };
  }
  if (deps.canRun && !deps.canRun(cli)) {
    return { ok: false, kind: "unreachable", reason: "That CLI can't take this yet. It can be tried again." };
  }
  const priced = roleModel("plan", routed);
  try {
    const text = await deps.run({
      harness: cli,
      ...(priced.model ? { model: priced.model } : {}),
      prompt,
    });
    return { ok: true, text };
  } catch (error) {
    return unfinished(error);
  }
}
