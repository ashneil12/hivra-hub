// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { plainProviderError } from "./providerError";

const raw = 'The build didn\'t go through: model call failed (grok/grok-4.7): HTTP 524: {"type": "error", "error": {"type": "api_error", "message": "Grok subscription upstream rejected this request"}}';

it("the raw 524 from a page build reads as one plain sentence, naming the service and no JSON", () => {
  const out = plainProviderError(raw);
  expect(out).toBe("The Grok model service turned the request away just now. Nothing changed; try again in a bit.");
  expect(out).not.toMatch(/[{}]|HTTP|api_error|grok-4\.7/);
});

it("rate limits and sign-in failures say what to do; other providers are named", () => {
  expect(plainProviderError("model call failed (deepseek/deepseek-chat): HTTP 429: too many requests")).toMatch(/^The DeepSeek model service is busy/);
  expect(plainProviderError('model call failed (claude/sonnet): HTTP 401: {"type":"error"}')).toMatch(/^The Claude model service .* sign-in/);
});

it("anything that isn't a provider failure is left as it was", () => {
  for (const text of ["Projects Manager turned it down: no.", "Say what the page should show.", ""]) expect(plainProviderError(text)).toBe(text);
});

it("a page build that fails at the provider shows Ash the plain sentence (buildPage)", async () => {
  const { buildPage } = await import("../../pages/model/buildPage");
  const { HubCallError } = await import("./hubTransport");
  const transport = { call: (async () => { throw new HubCallError("error", raw); }) as never, openFeed: () => () => undefined };
  const r = await buildPage({ projectId: "hub", monoId: "projects-manager", prompt: "a dashboard" } as never, { transport, roster: [{ id: "projects-manager" }], stub: false } as never);
  expect(r).toEqual({ status: "error", reason: "The Grok model service turned the request away just now. Nothing changed; try again in a bit." });
});
