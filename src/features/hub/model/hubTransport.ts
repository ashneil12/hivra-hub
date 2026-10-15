// The app's only door to Ash OS is the Rust `hub` plugin (src-tauri/src/hub.rs). It holds Ash OS's key; the webview
// never sees it. This file is the TypeScript end of that door, kept behind an interface so the stores can be tested
// against a stand-in.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type HubErrorKind = "unreachable" | "timeout" | "unauthorized" | "refused" | "error";

/** A failed call, in plain words. `kind` tells "Ash OS isn't running" from "Ash OS said no". */
export class HubCallError extends Error {
  readonly kind: HubErrorKind;
  constructor(kind: HubErrorKind, message: string) {
    super(message);
    this.name = "HubCallError";
    this.kind = kind;
  }
  /** True when Ash OS could not be reached or did not take the app's key: the calm "isn't running" state. */
  get isDown(): boolean {
    return this.kind === "unreachable" || this.kind === "timeout" || this.kind === "unauthorized";
  }
}

const KINDS: readonly string[] = ["unreachable", "timeout", "unauthorized", "refused", "error"];

/** What the plugin rejects with is `{kind, message}`; anything else (no Tauri at all) means Ash OS can't be reached. */
export function toHubError(raw: unknown): HubCallError {
  if (raw instanceof HubCallError) return raw;
  if (raw && typeof raw === "object" && "kind" in raw && "message" in raw) {
    const { kind, message } = raw as { kind: unknown; message: unknown };
    if (typeof kind === "string" && KINDS.includes(kind) && typeof message === "string") {
      return new HubCallError(kind as HubErrorKind, message);
    }
  }
  return new HubCallError("unreachable", "Ash OS isn't running.");
}

/** One change from Ash OS's feed. */
export type HubFeedEvent = {
  seq: number;
  kind: string;
  ref?: string | null;
  topics: string[];
  at?: string;
  project?: string;
};

/** The feed's connection. `reset` means the app's cursor was ahead of Ash OS: read everything again. */
export type HubFeedState = { connected: boolean; latest?: number; reset?: boolean; message?: string; kind?: string };

export type HubFeedHandlers = {
  onEvent(event: HubFeedEvent): void;
  onState(state: HubFeedState): void;
};

export interface HubTransport {
  /** One `ash-hub-*` call; resolves with the answer's `result`. */
  call<T = unknown>(action: string, payload?: Record<string, unknown>): Promise<T>;
  /** Open the live feed after `after`. Returns a function that closes it. */
  openFeed(after: number, handlers: HubFeedHandlers): () => void;
}

const PLUGIN = "plugin:hub|";

/** Ash's own ash-os MCP entry (command, args, env) from Claude Code's config, read by the plugin; null without one. */
export async function tauriAshOsServer(): Promise<{ command: string; args?: string[]; env?: Record<string, string> } | null> {
  try {
    return await invoke(`${PLUGIN}hub_ash_os_mcp`);
  } catch {
    return null;
  }
}

/** The real transport: the Rust plugin's `hub_call` and `hub_events_open`, plus its `hub:event` / `hub:state` events. */
export const tauriHubTransport: HubTransport = {
  async call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
    try {
      return await invoke<T>(`${PLUGIN}hub_call`, { action, payload });
    } catch (error) {
      throw toHubError(error);
    }
  },
  openFeed(after, handlers) {
    let closed = false;
    let opened = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      try {
        const offs = await Promise.all([
          listen<HubFeedEvent>("hub:event", (e) => handlers.onEvent(e.payload)),
          listen<HubFeedState>("hub:state", (e) => handlers.onState(e.payload)),
        ]);
        if (closed) {
          offs.forEach((off) => off());
          return;
        }
        unlisten.push(...offs);
        await invoke(`${PLUGIN}hub_events_open`, { after });
        opened = true;
        // Closed while the open was still on its way: close it now, it is ours.
        if (closed) void invoke(`${PLUGIN}hub_events_close`).catch(() => undefined);
      } catch (error) {
        if (!closed) handlers.onState({ connected: false, message: toHubError(error).message });
      }
    })();
    return () => {
      closed = true;
      unlisten.splice(0).forEach((off) => off());
      // Only a feed this window really opened is closed: another window may be sharing the running one.
      if (opened) void invoke(`${PLUGIN}hub_events_close`).catch(() => undefined);
    };
  },
};
