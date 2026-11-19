import { MORE_AGENT_COPY, type MoreAgentCheck } from "../../../features/providers/model/moreAgents";
import { AcpClient } from "../core/acp";
import { killChild, spawnMoreAgentChild, unwatchChild, watchChild } from "../core/child";
import { ACP_PROTOCOL_VERSION, GENERIC_CLIENT_CAPABILITIES, readInitialize } from "./acpProtocol";

/**
 * WP-134: the Check button. Starts one saved entry on the person's tap, asks `initialize`, then stops it. Nothing is
 * installed or downloaded. The start is refused in Rust unless the person approved this entry's command
 * (src-tauri/src/more_agents.rs), so a check never runs an unapproved command either.
 */

const CHECK_TIMEOUT_MS = 20_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plain words for a failed check. A timeout or a silent agent is "not answering", never a final failure. */
function failure(error: unknown): MoreAgentCheck {
  const detail = errorText(error);
  if (/not approved/i.test(detail)) return { status: "not_approved", message: detail };
  if (/no longer in your list/i.test(detail)) return { status: "gone", message: MORE_AGENT_COPY.gone };
  if (/not found|no such file/i.test(detail)) return { status: "not_found", message: MORE_AGENT_COPY.notFound };
  return { status: "not_answering", message: MORE_AGENT_COPY.notAnswering };
}

export async function checkMoreAgentEntry(
  agentId: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<MoreAgentCheck> {
  const sessionId = `more-check-${crypto.randomUUID()}`;
  const acp = new AcpClient(sessionId, {});
  watchChild(
    sessionId,
    (line) => acp.pushLine(line),
    () => acp.close(new Error("The agent exited")),
  );
  try {
    await spawnMoreAgentChild(sessionId, agentId, "~");
    const init = await acp.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: GENERIC_CLIENT_CAPABILITIES,
        clientInfo: { name: "hivra", version: "0.1.0" },
      },
      timeoutMs,
    );
    const outcome = readInitialize(init);
    if (!outcome.ok) return { status: "wrong_version", message: outcome.message };
    return {
      status: "ok",
      message: "This agent answered at version 1.",
      protocolVersion: ACP_PROTOCOL_VERSION,
      loadSession: outcome.loadSession,
      ...(outcome.agentName ? { agentName: outcome.agentName } : {}),
    };
  } catch (error) {
    return failure(error);
  } finally {
    acp.close(new Error("The check ended"));
    unwatchChild(sessionId);
    await killChild(sessionId).catch(() => undefined);
  }
}
