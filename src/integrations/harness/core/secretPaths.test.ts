import { describe, expect, it } from "vitest";
import { checkTurnForProtectedPaths, matchProtected, matchSecret, SECRET_PATHS } from "./protectedPaths";

describe("the secret-paths list (WP-178 item 3.4, report only)", () => {
  it("names SSH keys, cloud logins and keychains as secret places", () => {
    expect(matchSecret("~/.ssh/id_ed25519")).not.toBeNull();
    expect(matchSecret("~/.aws/credentials")).not.toBeNull();
    expect(matchSecret("~/.config/gcloud/application_default_credentials.json")).not.toBeNull();
    expect(matchSecret("~/Library/Keychains/login.keychain-db")).not.toBeNull();
    expect(matchSecret("~/.netrc")).not.toBeNull();
  });

  it("does not name ordinary project or home files", () => {
    expect(matchSecret("~/Documents/notes.txt")).toBeNull();
    expect(matchSecret("src/app.ts")).toBeNull();
    expect(matchSecret("~/.sshconfig-notes")).toBeNull();
  });

  it("is built from the shared JSON list, so the sandbox and the check read the same places", () => {
    const patterns = SECRET_PATHS.map((rule) => rule.pattern);
    expect(patterns).toContain("~/.ssh/**");
    expect(patterns).toContain("~/.netrc");
  });

  it("reports a changed secret path as a secret touch, and says nothing was blocked", () => {
    const report = checkTurnForProtectedPaths({ "~/.ssh/id_ed25519": "1:10" }, { "~/.ssh/id_ed25519": "1:20" });
    expect(report.touched).toEqual([
      expect.objectContaining({ path: "~/.ssh/id_ed25519", kind: "secret" }),
    ]);
    expect(report.summary).toContain("Reported only");
  });

  it("keeps project protected paths reported as kind protected", () => {
    const report = checkTurnForProtectedPaths({ ".git/hooks/pre-commit": "a" }, { ".git/hooks/pre-commit": "b" });
    expect(report.touched).toEqual([expect.objectContaining({ path: ".git/hooks/pre-commit", kind: "protected" })]);
  });
});

// WP-178: the secret places now come from the shared list's homeSecrets section (agentConfigPaths.json). The places
// the old agentSecretPaths.json named are written out here, so a drop from the shared list turns this red.
const PREVIOUSLY_LISTED_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".password-store",
  ".azure",
  ".config/gh",
  ".config/gcloud",
  ".config/rclone",
  ".config/wrangler",
  ".config/doctl",
  ".config/stripe",
  ".config/sops",
  "Library/Keychains",
];
const PREVIOUSLY_LISTED_FILES = [".netrc", ".npmrc", ".pypirc", ".git-credentials"];
const PREVIOUSLY_LISTED_CLI_LOGIN_FILES = [".claude.json", ".claude/.credentials.json", ".codex/auth.json"];
const PREVIOUSLY_LISTED_SHELL_PROFILES = [
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".config/fish/config.fish",
];

describe("the shared secret list keeps every place it held (WP-178 item 3)", () => {
  it.each(PREVIOUSLY_LISTED_DIRS)("still names the folder %s, and what is inside it", (dir) => {
    expect(matchSecret(`~/${dir}/inside`)).not.toBeNull();
    expect(matchSecret(`~/${dir}`)).not.toBeNull();
  });

  it.each(PREVIOUSLY_LISTED_FILES)("still names the file %s", (file) => {
    expect(matchSecret(`~/${file}`)).not.toBeNull();
  });

  it.each(PREVIOUSLY_LISTED_SHELL_PROFILES)("still protects the shell profile %s", (file) => {
    expect(matchProtected(`~/${file}`)).not.toBeNull();
  });

  it.each(PREVIOUSLY_LISTED_CLI_LOGIN_FILES)("still reports the CLI login file %s", (file) => {
    const report = checkTurnForProtectedPaths({ [`~/${file}`]: "1:10" }, { [`~/${file}`]: "1:20" });
    expect(report.touched).toEqual([expect.objectContaining({ path: `~/${file}`, kind: "secret" })]);
  });
});

describe("the fold rule the shared list uses (NFKC, case, long s, trailing dots and spaces)", () => {
  it.each([
    "~/.SSH/id_ed25519",
    "~/.ssh./id_ed25519",
    "~/.ssh /id_ed25519",
    "~/.ſsh/id_ed25519",
    "~/Library/keychains/login.keychain-db",
    "~/.NETRC.",
  ])("names %s as a secret place", (path) => {
    expect(matchSecret(path)).not.toBeNull();
  });

  it("does not fold a different name into a secret one", () => {
    expect(matchSecret("~/.sshx/id")).toBeNull();
    expect(matchSecret("~/.netrc.bak")).toBeNull();
  });
});

describe("the CLI login files are reported and never denied", () => {
  it("keeps the login files out of the folder and file lists the sandbox denies", () => {
    const patterns = SECRET_PATHS.map((rule) => rule.pattern);
    for (const file of PREVIOUSLY_LISTED_CLI_LOGIN_FILES) {
      expect(patterns).toContain(`~/${file}`);
    }
    expect(patterns).not.toContain("~/.claude/**");
    expect(patterns).not.toContain("~/.codex/**");
  });
});
