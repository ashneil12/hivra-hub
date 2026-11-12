// A provider's raw refusal, said in plain words with what to do (Ash 12 Nov: a bare "402 Insufficient Balance
// (request_id ...)" told him nothing). Only refusals we recognise are rewritten; anything else stays as it came.

/** The plain sentence for a raw provider error, or the message itself when it isn't one we know. */
export function plainErrorText(message: string): string {
  if (/insufficient[_ ]balance|\b402\b.*(?:balance|payment|credit)|payment required/i.test(message)) {
    // The provider's own words stay after it, so a wrong guess never hides what really failed.
    const raw = message.replace(/\s+/g, " ").trim();
    const said = raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
    return `The account behind this model looks out of credit, so this reply didn't come. Top up that account, or pick another model below and send again. (It said: ${said})`;
  }
  return message;
}
