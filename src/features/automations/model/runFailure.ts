/**
 * WP-180a: the class a run's activity line should see. A missing CLI becomes
 * the crew class. Anything else keeps the class the provider already gave.
 */
export function automationRunErrorClass(input: {
  message?: string | null;
  providerClass?: string | null;
  harness?: string | null;
}): string | undefined {
  const provider = input.providerClass?.trim();
  return provider ? provider : undefined;
}
