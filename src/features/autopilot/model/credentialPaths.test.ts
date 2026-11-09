// Where a login lives (WP-101 fix round 2, item B): a credential folder the command was never told the name of, and the
// files that hold one under names the red list's patterns don't list. Both lists are here, held and passing.
import { describe, expect, it } from "vitest";
import { credentialInText, credentialInWords, credentialName, credentialPath, walkHeld } from "./credentialPaths";

describe("a credential file, by name", () => {
  it.each([
    ".netrc",
    "_netrc",
    ".pgpass",
    ".my.cnf",
    ".npmrc",
    ".pypirc",
    ".dockercfg",
    ".git-credentials",
    ".s3cfg",
    ".boto",
    ".htpasswd",
    ".env",
    ".env.local",
    ".ENV",
    "app.env",
    "secrets.yaml",
    "secrets.yml",
    "secret.json",
    "credentials.json",
    "service-account.json",
    "token.txt",
    "my-token",
    "api_key.txt",
    "apikey.txt",
    "private.key",
    "server.pem",
    "cert.p12",
    "cert.pfx",
    "store.jks",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "kubeconfig",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "prod.tfvars",
    ".bash_history",
    ".zsh_history",
    ".psql_history",
    ".python_history",
    ".claude.json",
    "credentials.ts",
  ])("holds %s", (name) => {
    expect(credentialName(name), name).toBe(true);
  });

  it.each([
    "README.md",
    "tokenizer.ts",
    "keyboard.ts",
    "secretPatterns.json",
    "secret-patterns.ts",
    "notebook.py",
    "known_hosts",
    "index.html",
    "app.tsx",
    "package.json",
    "Cargo.toml",
    "notes.txt",
    "tokenizer.test.ts",
    "webToken.ts",
    ".env.example",
    ".env.sample",
  ])("lets %s through", (name) => {
    expect(credentialName(name), name).toBe(false);
  });
});

describe("a credential place, by any segment of a path", () => {
  it.each([
    "~/.aws/config",
    "~/.aws",
    "/Users/ash/.aws/credentials",
    "~/.kube/config",
    "~/.ssh/config",
    "~/.ssh",
    "~/.gnupg/secring.gpg",
    "~/.docker/config.json",
    "~/.config/gh/hosts.yml",
    "~/.config/gcloud/credentials.db",
    "~/.azure/accessTokens.json",
    "~/.npm",
    "~/.npmrc",
    "~/.password-store",
    "~/Library/Keychains/login.keychain-db",
    "~/Library/Application Support/Code/User/settings.json",
    "~/.mozilla/firefox/x/cookies.sqlite",
    "~/.pki/x",
    "~/.terraform.d/credentials.tfrc.json",
    "~/.gitconfig",
    ".git/config",
    "config/secrets.json",
    "secrets/app.yaml",
    "~/.hermes/auth.json",
    "~/.claude.json",
    "/etc/passwd",
    "/etc/shadow",
    "~/.zsh_history",
  ])("holds %s", (path) => {
    expect(credentialPath(path), path).toBe(true);
  });

  it.each([
    "src/app.ts",
    "README.md",
    "src/features/autopilot/model/tokenizer.ts",
    "/Users/ash/project/.env.example",
    "~/.ssh/known_hosts",
    "notes/plan.md",
    "package.json",
    "terraform/main.tf",
  ])("lets %s through", (path) => {
    expect(credentialPath(path), path).toBe(false);
  });

  it("holds a public key and an authorized_keys inside a login folder, whatever its own name says", () => {
    // A key's own name says nothing (`id_rsa.pub`); the folder does. `authorized_keys` alone names a file that holds
    // public keys, but one under `known_hosts` alone is a listing and passes.
    expect(credentialName("id_rsa.pub")).toBe(true);
    expect(credentialPath("~/.ssh/authorized_keys")).toBe(true);
  });
});

describe("words a command runs with", () => {
  it("finds the place however the command spells it", () => {
    expect(credentialInWords(["cat", "~/.aws"])).toBe("~/.aws");
    expect(credentialInWords(["ls", "-la", "~/.ssh"])).toBe("~/.ssh");
    expect(credentialInWords(["git", "show", "HEAD:.env"])).toBe("HEAD:.env");
    expect(credentialInWords(["find", ".", "-name", ".env"])).toBe(".env");
    expect(credentialInWords(["find", "~", "-name", "id_rsa", "-print"])).toBe("id_rsa");
    // A walk from the home folder names no file at all; the walk rule holds it, not this one.
    expect(credentialInWords(["find", "~", "-print"])).toBeNull();
    expect(credentialInWords(["rg", "--glob=.env", "x"])).toBe("--glob=.env");
  });

  it("does not mistake a search for a word for a file that holds one", () => {
    expect(credentialInWords(["grep", "token", "src/app.ts"])).toBeNull();
    expect(credentialInWords(["rg", "token"])).toBeNull();
    expect(credentialInWords(["rg", "-n", "secrets", "src"])).toBeNull();
    expect(credentialInWords(["cat", "README.md"])).toBeNull();
    expect(credentialInWords(["git", "log", "--oneline"])).toBeNull();
  });

  // WP-101 fix round 3, finding 1: a search skips a plain word as a content pattern. A word with `*`, `?` or `[` is a
  // filename glob, and ripgrep's `-g` matches a leading dot, so `*netrc*` prints the netrc. Holding a glob that names
  // nothing secret (`foo*`) is the safe side.
  it("holds a filename glob given to a search, including one glued on with =", () => {
    for (const words of [
      ["rg", "-g", "*netrc*", "."],
      ["rg", "-g", "*history*", "."],
      ["rg", "-g", "id_*", "."],
      ["rg", "--hidden", "-g", "*netrc*", "."],
      ["rg", "-uu", "-g", "*netrc*", "."],
      ["rg", "-uuu", "-g", "*history*", "."],
      ["rg", "--glob=*netrc*", "."],
      ["rg", "--iglob=*history*", "x"],
      ["rg", "--glob", "*netrc*", "."],
      ["ag", "-G", "*netrc*", "."],
      ["ag", "-G", "*history*", "."],
      ["ag", "-G=*netrc*", "."],
      ["fd", "-g", "*netrc*"],
      ["grep", "-r", "--include=*netrc*", ".", "."],
      ["grep", "-r", "--include=*history*", "."],
      ["grep", "-r", "--exclude=*netrc*", "."],
      ["rg", "foo*", "src"],
      ["rg", "foo?", "src"],
      ["rg", "foo[0-9]", "src"],
      ["rg", "-g", "id_?sa", "."],
      // Finding 6: find's -name / -iname / -path values are the same kind of glob.
      ["find", ".", "-name", "*netrc*"],
      ["find", ".", "-iname", "*history*"],
      ["find", ".", "-path", "*netrc*"],
    ])
      expect(credentialInWords(words), words.join(" ")).not.toBeNull();
  });

  it("reads prose for a path, not for a word", () => {
    expect(credentialInText("cat ~/.aws/credentials")).toBe(true);
    expect(credentialInText("read .env")).toBe(true);
    expect(credentialInText("the token budget is 40k")).toBe(false);
    expect(credentialInText("rotate the api key")).toBe(false);
  });
});

describe("a read that walks folders", () => {
  const FOLDER = "/Users/ash/Worktrees/hub-x";

  it("has to start inside the chat's own folder", () => {
    for (const words of [
      ["grep", "-r", ".", "~"],
      ["grep", "-r", ".", "~/"],
      ["grep", "-r", "x", "~/.aws"],
      ["grep", "-r", "x", "/Users"],
      ["grep", "-r", "x", "/"],
      ["grep", "-r", "x", ".."],
      ["grep", "-r", "x", `${FOLDER}/..`],
      ["rg", ".", "~/Library/Keychains"],
      ["rg", "-uuu", ".", "~"],
      ["rg", "--no-ignore", "x", "/Users/ash"],
      ["rg", "--hidden", "x", "/etc"],
      ["fd", ".", "~"],
      ["tree", "~"],
      ["du", "-a", "~"],
      ["ls", "-R", "~"],
      ["find", "~", "-name", "id_rsa"],
      ["find", "/", "-name", ".env"],
      ["ag", ".", "~"],
    ])
      expect(walkHeld(words, FOLDER), words.join(" ")).toBe(true);
    // A folder too broad to be a chat's own: only a relative place can be shown to stay inside the working folder.
    expect(walkHeld(["grep", "-r", "x", "src"], "/Users/ash")).toBe(false);
    expect(walkHeld(["grep", "-r", "x", "/Users/ash/src"], "/Users/ash")).toBe(true);
    expect(walkHeld(["grep", "-r", "x", "/etc"], undefined)).toBe(true);
    expect(walkHeld(["grep", "-r", "x", "../.."], undefined)).toBe(true);
  });

  it("stays allowed inside the chat's folder, and for reads that name their files", () => {
    for (const words of [
      ["grep", "-rn", "TODO", "src"],
      ["grep", "-r", "x", "."],
      ["rg", "foo", "src"],
      ["rg", "-n", "foo"],
      ["rg", "-uuu", "foo", "src"],
      ["find", ".", "-name", "*.ts"],
      ["find", "src", "-type", "f"],
      ["fd", "foo"],
      ["tree", "src"],
      ["du", "-sh", "src"],
      ["ls", "-R", "src"],
      ["ag", "foo", "src"],
      ["cat", "README.md"],
      ["grep", "TODO", "README.md"],
    ])
      expect(walkHeld(words, FOLDER), words.join(" ")).toBe(false);
  });
});
