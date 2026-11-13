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

// A PGP block ends `PRIVATE KEY BLOCK-----` and `SSH2` has a digit in it: the header words are letters, digits and
// spaces. The Rust side tests the same samples (src-tauri/src/commit_guard/tests.rs).
it("scrubs a PGP private key block and an SSH2 private key, but not a public key", () => {
  const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGPLANTEDbody\n-----END PGP PRIVATE KEY BLOCK-----";
  const ssh2 = "-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----\nAAAAPLANTEDbody\n-----END SSH2 ENCRYPTED PRIVATE KEY-----";
  for (const key of [pgp, ssh2, PRIVATE_KEY]) {
    expect(findSecrets(key), key).toEqual(["Private key"]);
    expect(redactText(`before\n${key}\nafter`)).toEqual({ text: `before\n${SECRET_MARKER}\nafter`, count: 1 });
  }
  // The block is found whole when its line breaks are escaped or CRLF.
  expect(redactText(pgp.replace(/\n/g, "\\n")).text).toBe(SECRET_MARKER);
  expect(redactText(pgp.replace(/\n/g, "\r\n")).text).toBe(SECRET_MARKER);
  const publicKey = "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQENBGPLANTEDbody\n-----END PGP PUBLIC KEY BLOCK-----";
  expect(redactText(publicKey)).toEqual({ text: publicKey, count: 0 });
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

// WP-248: passwords typed on a command line, in the shapes Claude Code saves as "don't ask again" rules in
// .claude/settings.local.json (LATENT, 8 Nov 2026, on Apiiro's 5 Nov report). The same samples are in the Rust test
// (src-tauri/src/portable/tests.rs). Made-up values.
const COMMAND_PASSWORDS: Array<[string, string, string]> = [
  ['"Bash(PGPASSWORD=hunter2 psql -h db.example.com -U app -d prod -c \\"select 1\\")"', "Password variable", "hunter2"],
  ["export PGPASSWORD='s3cr3t-pw'", "Password variable", "s3cr3t-pw"],
  ["MYSQL_PWD=abcd1234 mysql -u root", "Password variable", "abcd1234"],
  ['"Bash(mysql -u root -pS3cretPass99 -e \\"show databases\\")"', "mysql password", "S3cretPass99"],
  ["mysqldump -h db -u admin -p'Tr0ub4dor' shop > shop.sql", "mysql password", "Tr0ub4dor"],
  ["mysql --user=root --password=S3cretPass99 app", "mysql password", "S3cretPass99"],
  ['"Bash(sshpass -p MyPassw0rd ssh deploy@10.0.0.4 uptime)"', "sshpass password", "MyPassw0rd"],
  ['"Bash(curl -u admin:S3cretPass99 https://api.example.com/v1/items)"', "curl password", "S3cretPass99"],
  ["curl -s --user deploy:Zx9pass https://h.example.com", "curl password", "Zx9pass"],
  ['"Bash(redis-cli -h cache.internal -p 6379 -a S3cretPass99 ping)"', "redis-cli password", "S3cretPass99"],
  ["redis-cli --pass hunter22 info", "redis-cli password", "hunter22"],
];

const NOT_COMMAND_PASSWORDS = [
  "mysql -p",
  "Run mysql -u root -p and type the password when asked.",
  "mysql -h db -u admin -p mydb",
  "mysql -P 3306 -p -u root",
  "ls -a ~/projects",
  "git commit -a -m 'fix the build'",
  "tar -a -cf out.tar.gz dir",
  "redis-cli -a",
  "redis-cli --no-auth-warning -a $REDIS_PASSWORD ping",
  "redis-cli -a <password> ping",
  "sshpass -p",
  "sshpass -f ~/.pw ssh host",
  "curl -u admin https://example.com:8443/x",
  "curl -u $USER:$TOKEN https://example.com",
  "curl -u token: https://example.com",
  "curl -o out.json https://example.com:443/a",
  "PGPASSWORD=$PGPASS psql",
  'PGPASSWORD="${DB_PASSWORD}" psql',
  "Set PGPASSWORD= to your password",
  "The mysql client asks for a password with -p.",
];

it("finds a password typed on a command line (WP-248) and scrubs only the password", () => {
  for (const [line, name, password] of COMMAND_PASSWORDS) {
    expect(findSecrets(line), line).toContain(name);
    const r = redactText(line);
    expect(r.text, line).not.toContain(password);
    expect(r.text, line).toContain(SECRET_MARKER);
  }
  // The command around the password stays readable.
  expect(redactText("sshpass -p MyPassw0rd ssh deploy@host").text).toBe(`sshpass -p ${SECRET_MARKER} ssh deploy@host`);
});

it("leaves a command that only asks for a password, a variable or a plain -a flag alone (WP-248)", () => {
  for (const line of NOT_COMMAND_PASSWORDS) expect(findSecrets(line), line).toEqual([]);
});
