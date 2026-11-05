/** How much of a managed turn's reply is kept. The tail is what gets posted. */
const CONTROL_TEXT_CAP = 20_000;

/**
 * One event of a managed turn's reply.
 * A finished assistant message is its own paragraph. One newline runs "rest." into "Six".
 */
export function appendControlEvent(
  text: string,
  event: { type: string; text?: string },
): string {
  if (event.type === "message.delta")
    return (text + (event.text ?? "")).slice(-CONTROL_TEXT_CAP);
  if (event.type === "message.completed") return `${text}\n\n`;
  return text;
}
