import type { ClaudePermissionMode } from "./claudeProtocol";

/**
 * The launch settings of one Claude Code process, and which changes the
 * running process can take over control requests instead of a restart.
 *
 * Confirmed against CLI 2.1.302 (fixtures/claude-cli-2.1.302/live-settings-control.ndjson):
 * `set_model` (it checks the model with one small request, then answers;
 * `[1m]` ids work), `set_permission_mode` (answers `{mode}`, then a
 * `system/status` with `permissionMode`; `bypassPermissions` is refused with
 * `bypass_not_launched` unless the process was started with
 * `--allow-dangerously-skip-permissions`, which only a process started for
 * Full access gets: Full access chosen later on any other one restarts it),
 * and `apply_flag_settings` for
 * `effortLevel`, `fastMode`, `ultracode` and `autoCompactWindow`. Clearing
 * `effortLevel` live drops the flag but the session keeps the effort it had,
 * so going back to the default effort needs a new process, as do thinking,
 * hooks and a custom model route (its endpoint is in the process env).
 */
export type ClaudeLaunch = {
  /** API model id, `[1m]` included. */
  model?: string;
  /** Identity of a custom model route; routed models carry their endpoint in the env. */
  route?: string;
  /** The reasoning level a routed model was asked for (sent by the router, so a change needs a new process). */
  routeEffort?: string;
  effort?: string;
  permissionMode: ClaudePermissionMode;
  /**
   * Started with `--allow-dangerously-skip-permissions`: only a chat in Full
   * access at launch is, and only such a process can switch to it live.
   */
  allowBypass: boolean;
  thinking: boolean;
  fast: boolean;
  ultracode: boolean;
  hooks: boolean;
  autoCompactWindow?: number;
  /** The appended prompt's key (claudeExtraArgs.ts claudeAppend): a new one needs a new process. */
  appendKey?: string;
  /** Hivra WP-10: started as a first mate, without file-editing tools; a change needs a new process. */
  firstMate?: boolean;
};

export type ClaudeLiveRequest = {
  /** What changes, for the note in the chat. */
  label: string;
  request: Record<string, unknown>;
};

export type ClaudeLaunchDelta = {
  /** Changes only a new process can take, by label. */
  restart: string[];
  /** Control requests that apply the rest to the running process. */
  requests: ClaudeLiveRequest[];
};

export function claudeLaunchDelta(
  live: ClaudeLaunch,
  next: ClaudeLaunch,
): ClaudeLaunchDelta {
  const restart: string[] = [];
  const requests: ClaudeLiveRequest[] = [];

  if (live.route !== next.route) restart.push("model");
  else if (next.route && live.routeEffort !== next.routeEffort) restart.push("reasoning level");
  else if (live.model !== next.model) {
    if (next.route) restart.push("model");
    else if (next.model) {
      requests.push({
        label: "model",
        request: { subtype: "set_model", model: next.model },
      });
    } else restart.push("model");
  }
  if (live.thinking !== next.thinking) restart.push("thinking");
  if (live.hooks !== next.hooks) restart.push("hooks");
  if (live.appendKey !== next.appendKey) restart.push("MonoCode note");
  if (Boolean(live.firstMate) !== Boolean(next.firstMate)) restart.push("first mate");

  const flags: Record<string, unknown> = {};
  const flagLabels: string[] = [];
  if (live.effort !== next.effort) {
    if (next.effort === undefined) restart.push("effort");
    else {
      flags.effortLevel = next.effort;
      flagLabels.push("effort");
    }
  }
  if (live.fast !== next.fast) {
    flags.fastMode = next.fast ? true : null;
    flagLabels.push("fast mode");
  }
  if (live.ultracode !== next.ultracode) {
    flags.ultracode = next.ultracode ? true : null;
    flagLabels.push("ultracode");
  }
  if (live.autoCompactWindow !== next.autoCompactWindow) {
    flags.autoCompactWindow = next.autoCompactWindow ?? null;
    flagLabels.push("compaction size");
  }
  if (flagLabels.length > 0) {
    requests.push({
      label: flagLabels.join(", "),
      request: { subtype: "apply_flag_settings", settings: flags },
    });
  }

  if (live.permissionMode !== next.permissionMode) {
    // CLI 2.1.302 refuses bypassPermissions live on a process started
    // without the allowance (bypass_not_launched, recorded).
    if (next.permissionMode === "bypassPermissions" && !live.allowBypass) {
      restart.push("permission mode");
    } else {
      requests.push({
        label: "permission mode",
        request: { subtype: "set_permission_mode", mode: next.permissionMode },
      });
    }
  }
  return { restart, requests };
}

/** The launch a running process has after `next` was applied to it live: still started the way it was. */
export function appliedLaunch(live: ClaudeLaunch, next: ClaudeLaunch): ClaudeLaunch {
  return { ...next, allowBypass: live.allowBypass };
}

/** "model and permission mode", "effort, fast mode and thinking". */
export function joinLabels(labels: string[]): string {
  const unique = [...new Set(labels.flatMap((label) => label.split(", ")))];
  if (unique.length <= 1) return unique[0] ?? "settings";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}
