import { invoke } from "@tauri-apps/api/core";

/**
 * WP-255: computer use, off by default (src-tauri/src/computer_use/). Ported from Up.computer (MIT); the program that
 * reads and drives the apps is open-computer-use (MIT, iFurySt/open-computer-use), which Ash installs with npm.
 *
 * Settings > Computer use writes `<data>/computer-use.json`. A chat's Claude Code session gets the `computer` entry
 * (`monocode computer-use`) only while it is on and the chat isn't set to off; the entry reads that same file again
 * before every call, so turning it off holds at once.
 */
export type ComputerUseMode = "observe" | "control";
export type ChatComputerUse = "allow" | "observe-only" | "deny";

export type ComputerUseSettings = {
  enabled: boolean;
  mode: ComputerUseMode;
  allowedApps: string[];
  allowCoordinates: boolean;
  sidecar?: string;
  chats: Record<string, ChatComputerUse>;
};

export type ComputerUseView = {
  settings: ComputerUseSettings;
  settingsPath: string;
  /** The open-computer-use program found, if any. */
  sidecar: string | null;
  /** Only a Mac today. */
  supported: boolean;
};

export type ComputerUseActivity = {
  at: number;
  chat: string;
  tool: string;
  app?: string;
  detail: string;
  allowed: boolean;
  reason?: string;
};

export type ComputerUseChange = Pick<ComputerUseSettings, "enabled" | "mode" | "allowedApps" | "allowCoordinates">;

export const COMPUTER_USE_INSTALL = "npm i -g open-computer-use";

/** The last answer the app gave, for building a chat's arguments without waiting. */
let current: ComputerUseView | undefined;

export function rememberComputerUse(view: ComputerUseView | undefined): void {
  current = view && typeof view.settings?.enabled === "boolean" ? view : undefined;
}

export function knownComputerUse(): ComputerUseView | undefined {
  return current;
}

export async function loadComputerUse(): Promise<ComputerUseView | undefined> {
  try {
    rememberComputerUse(await invoke<ComputerUseView>("computer_use_get"));
  } catch {
    // An app that can't answer keeps the last answer; none means off.
  }
  return current;
}

export async function saveComputerUse(change: ComputerUseChange): Promise<ComputerUseView> {
  const view = await invoke<ComputerUseView>("computer_use_put", { change });
  rememberComputerUse(view);
  return view;
}

export async function setChatComputerUse(chat: string, mode: ChatComputerUse | null): Promise<ComputerUseView> {
  const view = await invoke<ComputerUseView>("computer_use_set_chat", { chat, mode });
  rememberComputerUse(view);
  return view;
}

export const loadComputerUseActivity = (limit = 50) =>
  invoke<ComputerUseActivity[]>("computer_use_activity", { limit });

export const checkComputerUse = () => invoke<{ ok: boolean; output: string }>("computer_use_check");

/** The chat's own say, or "allow" (follow Settings) when it has none. */
export function chatComputerUse(view: ComputerUseView | undefined, chat: string): ChatComputerUse {
  return view?.settings.chats[chat] ?? "allow";
}

/** Whether a chat's session gets the computer entry: on, on a Mac, and the chat not set to off. */
export function chatGetsComputerUse(view: ComputerUseView | undefined, chat: string): boolean {
  return !!view && view.supported && view.settings.enabled && !!view.settingsPath && chatComputerUse(view, chat) !== "deny";
}

/** The `computer` entry for one chat. The settings file and the chat are named; no secret is. */
export function computerUseServer(cli: string, chat: string, settingsPath: string): Record<string, unknown> {
  return {
    command: cli,
    args: ["computer-use"],
    env: {
      MONOCODE_COMPUTER_USE_SETTINGS: settingsPath,
      MONOCODE_COMPUTER_USE_CHAT: chat,
    },
  };
}

/** Typed list: one app per line or comma. */
export function splitApps(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const app = part.trim();
    if (app && !out.some((seen) => seen.toLowerCase() === app.toLowerCase())) out.push(app);
  }
  return out;
}

export function describeChatMode(mode: ChatComputerUse): string {
  if (mode === "deny") return "Off in this chat";
  if (mode === "observe-only") return "Look only in this chat";
  return "Follows Settings";
}
