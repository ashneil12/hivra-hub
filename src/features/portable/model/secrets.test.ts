import { expect, it } from "vitest";
import { findSecrets, isSecretKey, redactText, redactValue, SECRET_MARKER } from "./secrets";

// The same samples as the Rust scrubber's test (src-tauri/src/portable/tests.rs): one list, one behaviour.
const ANTHROPIC = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
const GITHUB = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAPLANTED\n-----END OPENSSH PRIVATE KEY-----";
const ASSIGNED = "password = Planted9Secret9Value9X";

it("scrubs the same secrets the Rust side does, and leaves mere mentions alone", () => {
  const r = redactText(`a ${ANTHROPIC} b ${GITHUB} c ${ASSIGNED} d\n${PRIVATE_KEY}\nAuthorization: Bearer abcDEF123456ghiJKL789xyz`);
  expect(r.count).toBe(5);
  expect(r.text).not.toMatch(/PLANTED|abcDEF123456/);
  expect(r.text).toContain(`password = ${SECRET_MARKER}`);
  const mentions = "tokens: 1200, the password field, secretName = my-secret-name, token = getToken()";
  expect(redactText(mentions)).toEqual({ text: mentions, count: 0 });
  expect(findSecrets(r.text)).toEqual([]);
  expect(findSecrets(`postgres://ash:hunter2pass@db.example.com/x`)).toEqual(["Password in a link"]);
});

// WP-102 item 3: shapes this scrubber used to miss. Made up, in each token's documented shape (prefix, separators,
// lengths); ordinary words that merely name the service must not match.
const GITLAB = "glpat-PLANTEDtoken0123456789ab";
const PYPI = `pypi-AgEIcHlwaS5vcmcPLANTED${"x".repeat(40)}`;
// SendGrid is `SG.` + 22 characters + `.` + 43 characters.
const SENDGRID = `SG.PLANTED${"a".repeat(15)}.PLANTED${"b".repeat(36)}`;
const SLACK_APP = "xapp-1-A0PLANTED01-1234567890123-PLANTEDslackappsecret";
const WEBHOOK_SECRET = "whsec_PLANTEDwebhooksecret0123456789";
const AWS_TEMPORARY = "ASIA" + "PLANTED2ABCDEFGH";

it("masks GitLab, PyPI, SendGrid, Slack app-level, Stripe webhook and temporary AWS shapes", () => {
  for (const token of [GITLAB, PYPI, SENDGRID, SLACK_APP, WEBHOOK_SECRET, AWS_TEMPORARY]) {
    const r = redactText(`before ${token} after`);
    expect(r.count, token).toBe(1);
    expect(r.text, token).toBe(`before ${SECRET_MARKER} after`);
    expect(findSecrets(token), token).not.toEqual([]);
  }
});

it("leaves ordinary words that name those services alone", () => {
  const prose =
    "Clone it from GitLab, publish it on PyPI, send mail with SendGrid, check the xapp- build, set whsec_ as the prefix, the ASIA region, and the glpat- docs.";
  expect(redactText(prose)).toEqual({ text: prose, count: 0 });
  expect(findSecrets(prose)).toEqual([]);
});

it("a value under a secret-looking key goes whatever it looks like", () => {
  const { value, count } = redactValue({ apiKey: "plainlettersonly", nested: [{ token: "abc" }, { note: ANTHROPIC }], input_tokens: 5 });
  expect(count).toBe(2);
  expect(value).toEqual({ apiKey: SECRET_MARKER, nested: [{ token: "abc" }, { note: SECRET_MARKER }], input_tokens: 5 });
  expect([isSecretKey("client_secret"), isSecretKey("tokens"), isSecretKey("secretName")]).toEqual([true, false, false]);
});
