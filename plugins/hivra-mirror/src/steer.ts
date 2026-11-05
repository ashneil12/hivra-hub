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
