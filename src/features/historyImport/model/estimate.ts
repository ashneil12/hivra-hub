// A ceiling, not a bill. Bytes divided by four, before tool noise and secrets
// are left out, so the number is "at most". A dollar figure is only shown with
// the rate it assumes. Ollama has no model fee. An unknown model stays in tokens.

const number = new Intl.NumberFormat("en-US");

export function tokensAtMost(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}

export function estimateSentence(bytes: number, provider: string | null, usdPerMillion: number | null = null): string {
  const tokens = number.format(tokensAtMost(bytes));
  const base = `About ${tokens} tokens at most.`;
  if (provider === "ollama") return `${base} On this Mac, no model fee.`;
  if (usdPerMillion == null) {
    return provider
      ? `${base} The price for this model isn't in the list, so this is tokens only.`
      : base;
  }
  const dollars = (tokensAtMost(bytes) / 1_000_000) * usdPerMillion;
  const cost = dollars < 0.01 ? "under $0.01" : `about $${dollars.toFixed(2)}`;
  return `${base} At $${usdPerMillion} per million tokens, that is ${cost}.`;
}
