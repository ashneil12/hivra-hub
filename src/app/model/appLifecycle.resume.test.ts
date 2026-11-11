// Review r3 repro (LOW, M6 residual) for #211. Red on 11be1d122.
// At start-up App.tsx calls bindResumedSessions (line ~2362) before the effect that opens each More agents chat's
// route (line ~3490). The saved ACP session id is bound through `session.harness` ("claude"), so it reaches the
// Claude adapter, and the More agents adapter never hears of it (its next turn starts a fresh `session/new`).
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn().mockResolvedValue(true) }));
vi.mock("./windowTransferBootstrap", () => ({ loadWindowTransfer: vi.fn().mockResolvedValue(null) }));

import { registerHarness, type HarnessAdapter } from "../../integrations/harness/core/registry";
import { newSession, type Session } from "../../features/sessions/model/session";
import { bindResumedSessions } from "./appLifecycle";

describe("review 211 r3: start-up bind of a More agents chat", () => {
  it("does not bind a More agents chat's saved ACP session to the Claude adapter", () => {
    const bindSession = vi.fn();
    registerHarness({
      id: "claude",
      live: true,
      bindSession,
      sendTurn: vi.fn(),
      cancelTurn: vi.fn(),
      respondApproval: vi.fn(),
      stopSession: vi.fn(),
      forgetSession: vi.fn(),
    } as unknown as HarnessAdapter);
    const session: Session = {
      ...newSession("claude", "/tmp/review-211"),
      registryAgentId: "gemini-acp",
      providerSessionId: "acp-session-1",
    };
    bindResumedSessions([session]);
    expect(bindSession).not.toHaveBeenCalled();
  });
});
