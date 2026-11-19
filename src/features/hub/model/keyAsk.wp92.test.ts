// Hivra WP-92: the "Needs Ash (provide)" path, when the thing asked for is a key.
import { describe, expect, it } from "vitest";
import { keyAskFor, secretNameFor } from "./chatQuestions";

const chat = (last: string, extra: { role: "user" | "assistant"; text: string; internal?: boolean }[] = []) => ({
  busy: false,
  blocks: [
    { role: "user" as const, text: "See if the customer list loads." },
    { role: "assistant" as const, text: last },
    ...extra,
  ],
});

describe("WP-92: a finished turn's key ask opens the secret form", () => {
  it("finds the (provide) ask and guesses the vault name", () => {
    const asked = keyAskFor(
      chat(
        "I stopped at the key.\nNeeds Ash (provide): a Stripe live secret key, so I can list the customers\nMy pick: the live key, not the test one.",
      ),
    );
    expect(asked).not.toBeNull();
    expect(asked!.ask).toMatch(/stripe live secret key/i);
    expect(asked!.name).toBe("stripe-live-secret-key");
  });

  it("leaves anything that is not a key to the normal reply", () => {
    expect(keyAskFor(chat("Needs Ash (provide): git access to the hivra repo, so I can push the fix"))).toBeNull();
  });

  it("is nothing when the turn is still running", () => {
    expect(keyAskFor({ ...chat("Needs Ash (provide): a Resend API key"), busy: true })).toBeNull();
  });

  it("is nothing once Ash answered that question", () => {
    const asked = chat("Needs Ash (provide): a Resend API key, so I can send the test email");
    expect(keyAskFor(asked)).not.toBeNull();
    const answered = {
      ...asked,
      blocks: [
        ...asked.blocks,
        { role: "user" as const, text: '[MonoCode Ash answered] answered your question "a Resend API key, so I can send the test email"' },
      ],
    };
    expect(keyAskFor(answered)).toBeNull();
  });

  it("an ordinary question is not a key ask", () => {
    expect(keyAskFor(chat("Needs Ash: publish the page now, or wait?\nMy pick: wait."))).toBeNull();
  });
});

describe("WP-92: the name guessed from the ask is one the vault accepts", () => {
  it.each([
    ["a Stripe live secret key,", "stripe-live-secret-key"],
    ["a new Resend API key for Hivra", "resend-api-key"],
    ["your Anthropic API key", "anthropic-api-key"],
    ["the GitHub token", "github-token"],
    ["a password", "password"],
  ])("%s -> %s", (ask, name) => {
    expect(secretNameFor(ask)).toBe(name);
  });

  it("falls back to 'secret' when nothing is left", () => {
    for (const ask of ["", "???", "a", "the new"]) expect(secretNameFor(ask)).toBe("secret");
  });

  it("keeps only lower-case letters, digits and dashes, and never over 64", () => {
    const name = secretNameFor("café API key, 100% sicher!! / \\ .. " + "x".repeat(200));
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toContain("..");
  });
});
