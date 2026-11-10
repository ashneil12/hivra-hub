import { saveChosenClis } from "../../src/features/hub/model/codingTeamHome";
import { setHarnessAvailability } from "../../src/integrations/harness/core/availabilityState";
import { HARNESSES, type HarnessId } from "../../src/features/sessions/model/session";

/**
 * Every CLI is installed, and Ash has ticked Claude Code, Cursor and Pi. The lead strip may offer only Claude Code,
 * the one ticked CLI that can lead. See leadCliStrip.ts for the wording and the CLIs it must not offer.
 */
export function installLeadStripHarnesses(): void {
  const availability = Object.fromEntries(HARNESSES.map((id) => [id, true])) as Record<HarnessId, boolean>;
  setHarnessAvailability(availability);
  saveChosenClis(["claude", "cursor", "pi"]);
}
