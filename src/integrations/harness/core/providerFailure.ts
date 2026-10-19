import type { HarnessEvent, ProviderErrorClass } from "./types";

/**
 * How each failure class reads to a person: in a Lead's report ("failed:
 * billing refused"), in the chat, and as a stuck reason.
 */
export const PROVIDER_ERROR_LABEL: Record<ProviderErrorClass, string> = {
  usage_limit: "usage limit reached",
  billing: "billing refused",
  auth: "auth refused",
  overloaded: "API overloaded",
  provider_error: "provider error",
};

const CLASSES = new Set<string>(Object.keys(PROVIDER_ERROR_LABEL));

export function isProviderErrorClass(
  value: unknown,
): value is ProviderErrorClass {
  return typeof value === "string" && CLASSES.has(value);
}

/** "failed: billing refused" */
export function failedReason(errorClass: ProviderErrorClass): string {
  return `failed: ${PROVIDER_ERROR_LABEL[errorClass]}`;
}

/** "API retry 4 of 10 · API overloaded (529)" */
export function providerRetryText(
  retry: Extract<HarnessEvent, { type: "provider.retry" }>,
): string {
  const status = retry.errorStatus;
  const what =
    retry.errorClass === "usage_limit"
      ? "rate limited"
      : retry.errorClass !== "provider_error"
        ? PROVIDER_ERROR_LABEL[retry.errorClass]
        : status == null
          ? "connection problem"
          : status >= 500
            ? "server error"
            : "request failed";
  return `API retry ${retry.attempt} of ${retry.maxAttempts} · ${what}${status != null ? ` (${status})` : ""}`;
}
