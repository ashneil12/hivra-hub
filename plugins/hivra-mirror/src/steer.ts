// WP-85. What Hivra sends a session: a reply queued for the next turn, an interrupt, or a permission answer.
// Shaped for Claude Code's stream-json, which scripts/fake-claude.mjs speaks.

export type Steer =
  | { kind: "reply"; text: string }
  | { kind: "stop" }
  | { kind: "permission"; requestId: string; allow: boolean; answers?: Record<string, string> };

export function steerMessage(action: Steer): unknown {
  if (action.kind === "reply") {
    return {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: action.text }] },
      parent_tool_use_id: null,
    };
  }
  if (action.kind === "stop") {
    return { type: "control_request", request_id: "hivra-stop", request: { subtype: "interrupt" } };
  }
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: action.requestId,
      response: {
        behavior: action.allow ? "allow" : "deny",
        updatedInput: { answers: action.answers ?? {} },
      },
    },
  };
}

export function steerLine(action: Steer): string {
  return JSON.stringify(steerMessage(action));
}

/** What a PermissionRequest hook prints when Hivra has an answer. No answer means the terminal asks, as usual. */
export function permissionHookOutput(answer: { allow: boolean } | null): string | null {
  if (!answer) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: answer.allow ? "allow" : "deny" },
    },
  });
}

/**
 * What the hook prints for this turn.
 * A permission answer is only for the prompt that asked. A reply leaves on Stop or the next user prompt.
 * A stop is not printed: a stock hook does not own the terminal's stdin, so it cannot interrupt the running turn.
 */
export function hookDecision(hookName: string, steers: readonly Steer[], requestId: string): string | null {
  const name = hookName.toLowerCase();
  if (name.includes("permission")) {
    const match = steers.find((item) => item.kind === "permission" && item.requestId === requestId);
    return match && match.kind === "permission" ? permissionHookOutput({ allow: match.allow }) : null;
  }
  const reply = steers.find((item) => item.kind === "reply");
  if (!reply || reply.kind !== "reply") return null;
  if (name.includes("stop")) return JSON.stringify({ decision: "block", reason: reply.text });
  if (name.includes("userprompt")) {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: reply.text },
    });
  }
  return null;
}

/** Poll until the matching prompt has an answer. One failed read or wait is not a final no. */
export async function waitForPermission(input: {
  requestId: string;
  attempts: number;
  poll: () => Promise<readonly Steer[]>;
  sleep: () => Promise<void>;
}): Promise<Steer[] | null> {
  const requestId = input.requestId.trim();
  if (!requestId || input.attempts < 1) return null;
  for (let i = 0; i < input.attempts; i += 1) {
    let steers: readonly Steer[] = [];
    try {
      steers = await input.poll();
    } catch {
      steers = [];
    }
    if (hookDecision("PermissionRequest", steers, requestId)) return [...steers];
    try {
      await input.sleep();
    } catch {
      // A missed pause is not a reason to give up on the answer.
    }
  }
  return null;
}
