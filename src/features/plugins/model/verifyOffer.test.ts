import { describe, expect, it } from "vitest";
import { offerSentence, offerVisible, readDecline, readOffer } from "./verifyOffer";

const COMMIT = "6ea74587e384e1a8035c09ae33a46fe3f881eb9b";

function offer(patch: Record<string, unknown> = {}) {
  return {
    surfaces: ["web"],
    installed: false,
    declined: false,
    revision: 0,
    source: { kind: "npm", package: "e2e", version: "0.22.0" },
    ...patch,
  };
}

describe("readOffer", () => {
  it("keeps web and mobile, in order, and drops anything else", () => {
    const read = readOffer(offer({ surfaces: ["mobile", "nope", "web", "web", "mobile"] }));
    expect(read?.surfaces).toEqual(["mobile", "web"]);
    expect(offerVisible(read)).toBe(true);
  });

  it("is nothing when the shape is wrong", () => {
    expect(readOffer(null)).toBeNull();
    expect(readOffer(offer({ surfaces: "web" }))).toBeNull();
    expect(readOffer(offer({ installed: "yes" }))).toBeNull();
    expect(readOffer(offer({ declined: 1 }))).toBeNull();
    expect(readOffer(offer({ revision: -1 }))).toBeNull();
    expect(readOffer(offer({ revision: 1.5 }))).toBeNull();
  });

  it("drops a source that is not a pinned npm package or git commit", () => {
    expect(readOffer(offer({ source: { kind: "npm", package: "E2E", version: "0.22.0" } }))?.source).toBeNull();
    expect(readOffer(offer({ source: { kind: "npm", package: "e2e", version: "^1.0.0" } }))?.source).toBeNull();
    expect(readOffer(offer({ source: { kind: "npm", package: "e2e", version: "0.22.0-beta.1" } }))?.source).toEqual({
      kind: "npm",
      package: "e2e",
      version: "0.22.0-beta.1",
    });
    expect(readOffer(offer({ source: { kind: "local", path: "/tmp/e2e" } }))?.source).toBeNull();
    const git = readOffer(offer({
      source: { kind: "git", url: "https://github.com/tester-army/e2e", commit: COMMIT.toUpperCase(), path: "packages/e2e" },
    }));
    expect(git?.source).toEqual({
      kind: "git",
      url: "https://github.com/tester-army/e2e",
      commit: COMMIT,
      path: "packages/e2e",
    });
    expect(readOffer(offer({
      source: { kind: "git", url: "https://github.com/tester-army/e2e", commit: COMMIT, path: "../secret" },
    }))?.source).toBeNull();
    expect(readOffer(offer({
      source: { kind: "git", url: "http://github.com/tester-army/e2e", commit: COMMIT },
    }))?.source).toBeNull();
  });

  it("is hidden once installed, declined, or with nothing to install", () => {
    expect(offerVisible(readOffer(offer({ installed: true })))).toBe(false);
    expect(offerVisible(readOffer(offer({ declined: true })))).toBe(false);
    expect(offerVisible(readOffer(offer({ surfaces: [] })))).toBe(false);
    expect(offerVisible(readOffer(offer({ source: null })))).toBe(false);
  });

  it("says what the project looks like", () => {
    expect(offerSentence(readOffer(offer())!)).toBe("This project looks like a web app.");
    expect(offerSentence(readOffer(offer({ surfaces: ["mobile"] }))!)).toBe("This project looks like a mobile app.");
    expect(offerSentence(readOffer(offer({ surfaces: ["web", "mobile"] }))!)).toBe(
      "This project looks like a web and mobile app.",
    );
  });

  it("reads a decline only when both parts are there", () => {
    expect(readDecline({ applied: false, offer: offer({ revision: 2 }) })).toEqual({
      applied: false,
      offer: readOffer(offer({ revision: 2 })),
    });
    expect(readDecline({ applied: "yes", offer: offer() })).toBeNull();
    expect(readDecline({ applied: true, offer: { revision: 1 } })).toBeNull();
  });
});
