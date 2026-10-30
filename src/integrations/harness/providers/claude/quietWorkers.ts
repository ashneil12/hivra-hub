import type { ClaudeCliSettings } from "./claudeProtocol";

/**
 * r83 (Ash: "turn them off for hub workers only, through the hub's spawn flags or environment, without touching
 * ~/.claude"): a Claude Code process the hub starts never pings Ash on its own. The hub already tells him when a
 * worker needs him (its permission card, Today, the Inbox); Claude Code's own phone pushes (Ash's ~/.claude has
 * agentPushNotifEnabled on) and its "Claude needs your permission" Notification hooks would be a second, unmanaged
 * channel. Flag settings outrank ~/.claude/settings.json, so this holds for these processes only and leaves his own
 * terminal Claude as it is.
 */
export const WORKER_NOTIFICATIONS_OFF = {
  agentPushNotifEnabled: false,
  inputNeededNotifEnabled: false,
  taskCompleteNotifEnabled: false,
} as const;

export const WORKER_NOTIFY_ENV = { CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS: "1" } as const;

export function withWorkerNotificationsOff(settings: ClaudeCliSettings): ClaudeCliSettings {
  return { ...settings, ...WORKER_NOTIFICATIONS_OFF, env: { ...settings.env, ...WORKER_NOTIFY_ENV } };
}
