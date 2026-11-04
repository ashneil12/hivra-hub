// Building a panel from a prompt is Creator mode (WP-34). This returns no spec and calls nothing: Creator mode
// builds it, and the old outside builder is not used.

export const CREATOR_MODE = "A panel is built in Creator mode.";

export function buildPanelFromPrompt(): { status: "creator"; reason: string } {
  return { status: "creator", reason: CREATOR_MODE };
}
