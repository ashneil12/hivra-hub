import type { ControlOutcome } from "../../features/orchestration/model/orchestration";
import type { HarnessEvent } from "../../integrations/harness/core/types";

type ProviderFailure = Pick<
  ControlOutcome,
  "error" | "errorClass" | "retryable" | "resetsAt"
>;

/**
 * A provider's error report becomes the monitored turn's failure. A later
 * report replaces an earlier one whole, so a class never outlives its error.
 */
export function withProviderFailure(
  outcome: ControlOutcome,
  event: Extract<HarnessEvent, { type: "session.error" }>,
): ControlOutcome {
  const {
    error: _error,
    errorClass: _errorClass,
    retryable: _retryable,
    resetsAt: _resetsAt,
    ...rest
  } = outcome;
  return {
    ...rest,
    ...definedFailure({
      error: event.message,
      errorClass: event.errorClass,
      retryable: event.retryable,
      resetsAt: event.resetsAt,
    }),
  };
}

/** The failure a settled outcome reports, without empty fields. */
export function providerFailureOf(outcome: ControlOutcome): ProviderFailure {
  return definedFailure(outcome);
}

function definedFailure(failure: ProviderFailure): ProviderFailure {
  return {
    ...(failure.error ? { error: failure.error } : {}),
    ...(failure.errorClass ? { errorClass: failure.errorClass } : {}),
    ...(failure.retryable !== undefined
      ? { retryable: failure.retryable }
      : {}),
    ...(failure.resetsAt != null ? { resetsAt: failure.resetsAt } : {}),
  };
}
