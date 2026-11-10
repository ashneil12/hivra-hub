/**
 * Sends a parent's allow or deny to the child session that asked.
 * The child port is the only place an answer is written. A missing port, a
 * port that does not match its key, or a write that throws is unreachable:
 * that is not a deny, and it is not sent to the parent.
 */

export type ChildAnswer = {
  requestId: string;
  decision: "allow" | "deny";
};

export type SessionPort = {
  id: string;
  write: (answer: ChildAnswer) => void;
};

export type ChildApproval = {
  name: string;
  sessionPort: string;
  detail?: string;
};

function cleanLine(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function cleanPort(value: string): string {
  const port = value.replace(/\r/g, "").trim();
  if (!port || /[\u0000-\u001f]/.test(port)) return "";
  return port;
}

/** A child worth showing. Empty or broken values are dropped, not invented. */
export function childApprovalFrom(value: unknown): ChildApproval | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { name?: unknown; sessionPort?: unknown; detail?: unknown };
  const name = typeof row.name === "string" ? cleanLine(row.name) : "";
  const sessionPort = typeof row.sessionPort === "string" ? cleanPort(row.sessionPort) : "";
  if (!name || !sessionPort) return undefined;
  const detail = typeof row.detail === "string" ? cleanLine(row.detail) : "";
  return detail ? { name, sessionPort, detail } : { name, sessionPort };
}

/**
 * Writes one allow or deny to the named child port.
 * Returns "unreachable" without writing when the port is missing, the port's
 * id does not match the key, the ids are empty, or the write throws.
 */
export function forwardChildAnswer(
  approval: { requestId: string; sessionPort: string },
  decision: "allow" | "deny",
  ports: ReadonlyMap<string, SessionPort>,
): "sent" | "unreachable" {
  if (decision !== "allow" && decision !== "deny") return "unreachable";
  const requestId = typeof approval.requestId === "string" ? approval.requestId.replace(/\r/g, "").trim() : "";
  const sessionPort = typeof approval.sessionPort === "string" ? cleanPort(approval.sessionPort) : "";
  if (!requestId || !sessionPort) return "unreachable";
  const port = ports.get(sessionPort);
  if (!port || port.id !== sessionPort) return "unreachable";
  try {
    port.write({ requestId, decision });
  } catch {
    return "unreachable";
  }
  return "sent";
}
