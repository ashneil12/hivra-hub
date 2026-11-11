import {
  classifyAdapterFailure,
  MISSING_CLI,
  SDK_NOT_INSTALLED,
} from "../../crew/model/failure";

/**
 * WP-180a: the class a run's activity line should see. A missing CLI becomes
 * the crew class. Anything else keeps the class the provider already gave.
 */
const CLI_NOT_FOUND = /CLI not found/i;

function adapterFor(harness: string | null | undefined): string {
  const id = harness?.trim() ?? "";
  if (id === "claude") return "claude-code";
  return id;
}

export function automationRunErrorClass(input: {
  message?: string | null;
  providerClass?: string | null;
  harness?: string | null;
}): string | undefined {
  const message = input.message ?? "";
  const crew = classifyAdapterFailure(adapterFor(input.harness), message);
  if (CLI_NOT_FOUND.test(message) || crew === MISSING_CLI) return MISSING_CLI;
  if (crew === SDK_NOT_INSTALLED) return SDK_NOT_INSTALLED;
  const provider = input.providerClass?.trim();
  return provider ? provider : undefined;
}
