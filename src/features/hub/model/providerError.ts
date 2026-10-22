/**
 * A model provider's failure in Ash's words. Ash OS passes a failed model call through as developer text
 * ("model call failed (grok/grok-4.7): HTTP 524: {"type":"error",...}"); Ash reads one plain sentence instead
 * (C3 live 22 Oct: the raw 524 JSON showed on Pages). Anything that isn't a provider failure comes back unchanged.
 */
const PROVIDERS: [RegExp, string][] = [
  [/\bgrok\b|\bxai\b/i, "Grok"],
  [/deepseek/i, "DeepSeek"],
  [/claude|anthropic/i, "Claude"],
  [/openai|gpt/i, "OpenAI"],
  [/gemini|google/i, "Gemini"],
];

export function providerName(text: string): string | undefined {
  const model = /model call failed \(([^)]+)\)/i.exec(text)?.[1] ?? text;
  return PROVIDERS.find(([re]) => re.test(model))?.[1];
}

export function isProviderFailure(text: string): boolean {
  return /model call failed/i.test(text) || /HTTP\s*\d{3}\s*:\s*\{|"type"\s*:\s*"error"/i.test(text);
}

/** One plain sentence for a provider failure, or the text as it was. */
export function plainProviderError(text: string): string {
  if (!text || !isProviderFailure(text)) return text;
  const who = providerName(text);
  const service = who ? `The ${who} model service` : "The model service";
  const status = Number(/HTTP\s*(\d{3})/i.exec(text)?.[1] ?? 0);
  if (status === 429 || /rate.?limit|too many requests/i.test(text)) return `${service} is busy with too many requests just now. Try again in a few minutes.`;
  if (status === 401 || status === 403) return `${service} turned the request away because its sign-in isn't working. Check that account in Settings, then try again.`;
  return `${service} turned the request away just now. Nothing changed; try again in a bit.`;
}
