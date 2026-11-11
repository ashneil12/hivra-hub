// Where a login lives (WP-101 fix round 2, item B): a credential folder the command was never told the name of, and the
// files that hold one under names the red list's patterns don't list. Both lists are here, held and passing.
import { describe, expect, it } from "vitest";
import { credentialInPaths, credentialInText, credentialInWords, credentialName, credentialPath, walkHeld } from "./credentialPaths";

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
    "/Users/someone/.aws/credentials",
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
    // WP-101 fix round 4, finding 3: master.passwd is the password file on a Mac.
    "/etc/master.passwd",
    "/private/etc/master.passwd",
    "/etc/./master.passwd",
    "//etc//master.passwd",
    "/ETC/MASTER.PASSWD",
    "/System/Volumes/Data/private/etc/master.passwd",
    "~/.zsh_history",
  ])("holds %s", (path) => {
    expect(credentialPath(path), path).toBe(true);
  });

  it.each([
    "src/app.ts",
    "README.md",
    "src/features/autopilot/model/tokenizer.ts",
    "/Users/someone/project/.env.example",
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

  // WP-101 fix round 3, finding 7: a shell startup file or a preferences file under the home folder is not a project
  // file. A relative name in the chat's folder is, and stays a read.
  it("holds a home shell startup file or a preferences file", () => {
    for (const words of [
      ["cat", "~/.zshrc"],
      ["cat", "~/.bashrc"],
      ["cat", "~/.profile"],
      ["cat", "~/.bash_profile"],
      ["cat", "~/.zprofile"],
      ["cat", "~/.zshenv"],
      ["cat", "~/.zlogin"],
      ["head", "~/.zshrc"],
      ["tail", "~/.bashrc"],
      ["cat", "~/Library/Preferences/com.apple.foo.plist"],
      ["cat", "/Users/someone/.zshrc"],
      ["cat", "/home/user/.profile"],
      ["cat", "/Users/someone/Library/Preferences/com.apple.foo.plist"],
      ["cat", "/home/user/Library/Preferences/foo.plist"],
      ["cat", "~/Library/Preferences"],
    ])
      expect(credentialInWords(words), words.join(" ")).not.toBeNull();
    expect(credentialInWords(["cat", ".zshrc"])).toBeNull();
    expect(credentialInWords(["cat", "src/.zshrc"])).toBeNull();
    expect(credentialInWords(["cat", "~/notes.txt"])).toBeNull();
    expect(credentialInWords(["cat", "/Users/someone/Worktrees/hub-x/README.md"])).toBeNull();
  });

  it("holds the password file of a Mac under any command that names it", () => {
    for (const words of [
      ["cat", "/etc/master.passwd"],
      ["head", "-n", "3", "/private/etc/master.passwd"],
      ["grep", "root", "/etc/master.passwd"],
      ["git", "diff", "--no-index", "/etc/master.passwd", "/dev/null"],
      ["ls", "-l", "/etc/master.passwd"],
    ])
      expect(credentialInWords(words), words.join(" ")).not.toBeNull();
    expect(credentialInWords(["cat", "/etc/hosts"])).toBeNull();
    expect(credentialInWords(["cat", "master.passwd"])).toBeNull();
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

// WP-101 fix round 4, finding 1 (HIGH): the home check compared the raw word's first characters, so the same file written
// `/./Users/…`, `//Users/…`, `/../Users/…`, `/users/…` was a different word to it. The kernel opens all of them. Every
// spelling below names a file the plain form already holds, and every one has to hold.
describe("a home file under another spelling (fix round 4, finding 1)", () => {
  const FOLDER = "/Users/someone/Worktrees/hub-x";
  const HOMES = [
    // the plain forms
    "~",
    "~/",
    "/Users/someone",
    "/home/someone",
    // a dot or a doubled slash anywhere on the way
    "~/.",
    "~//",
    "~/./.",
    "/./Users/someone",
    "/././Users/someone",
    "//Users/someone",
    "///Users//someone",
    "/Users/./someone",
    "/Users//someone",
    "/Users/someone/.",
    "/./home/someone",
    "//home//someone",
    // climbing: `..` at the root stays at the root, so this still lands in the same place
    "/../Users/someone",
    "/../../Users/someone",
    "/../../../../../Users/someone",
    "/usr/local/../../Users/someone",
    "/tmp/../Users/someone",
    "/Users/x/../someone",
    "/Users/someone/Library/..",
    "/Users/someone/x/y/../..",
    "~/../someone",
    "~/x/../../someone",
    "/home/x/../someone",
    // a Mac's file system is case-insensitive: any case is the same folder
    "/users/someone",
    "/USERS/someone",
    "/UsErS/SOMEONE",
    "/Users/SOMEONE",
    "/HOME/someone",
    // the Mac's own other names for the same folder (firmlinks and the boot-volume link)
    "/System/Volumes/Data/Users/someone",
    "/system/volumes/data/users/someone",
    "/System/Volumes/Data/./Users/someone",
    "/Volumes/Macintosh HD/Users/someone",
    "/Volumes/Data/Users/someone",
    "/Volumes/Macintosh HD/System/Volumes/Data/Users/someone",
    // root's own home on a Mac and on Linux
    "/var/root",
    "/private/var/root",
    "/root",
    // a Windows path, either slash
    "C:/Users/someone",
    "c:\\Users\\someone",
  ];
  const TARGETS = [
    ".zshrc",
    ".bashrc",
    ".profile",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".zlogout",
    ".bash_login",
    ".bash_logout",
    ".kshrc",
    ".cshrc",
    ".tcshrc",
    ".login",
    ".logout",
    "./.zshrc",
    "//.zshrc",
    "x/../.zshrc",
    ".ZSHRC",
    ".zshrc/",
    ".zshrc/.",
    "Library/Preferences/com.apple.foo.plist",
    "Library/./Preferences/com.apple.foo.plist",
    "Library//Preferences/com.apple.foo.plist",
    "Library/x/../Preferences/com.apple.foo.plist",
    "library/preferences/com.apple.foo.plist",
    "LIBRARY/PREFERENCES/com.apple.foo.plist",
    "Library/Preferences",
    "Library/Preferences/",
  ];
  const join = (home: string, target: string) => `${home.replace(/\/$/, "")}/${target}`;

  it("holds every spelling of a home shell startup file or preferences file", () => {
    const missed: string[] = [];
    for (const home of HOMES) {
      for (const target of TARGETS) {
        const word = join(home, target);
        if (!credentialInWords(["cat", word])) missed.push(word);
      }
    }
    expect(missed).toEqual([]);
  });

  it("holds the same spellings for head, tail, grep and git diff, and when the word is glued to an option", () => {
    for (const word of [
      "/./Users/someone/.zshrc",
      "//Users/someone/.zshrc",
      "/../Users/someone/.zshrc",
      "/usr/local/../../Users/someone/.zshrc",
      "/users/someone/.zshrc",
      "/USERS/someone/.zshrc",
      "/./Users/someone/Library/Preferences/com.apple.foo.plist",
    ]) {
      for (const words of [
        ["head", "-n", "10000", word],
        ["tail", "-n", "+1", word],
        ["grep", "export", word],
        ["grep", ".", word],
        ["grep", "-n", "-e", "x", word],
        ["wc", "-l", word],
        ["file", word],
        ["stat", word],
        ["git", "diff", "--no-index", word, "/dev/null"],
        ["git", "diff", word, "/dev/null"],
        ["git", "diff", "--no-index", "/dev/null", word],
        ["grep", `--file=${word}`, "x"],
        ["wc", `--files0-from=${word}`],
        ["rg", `--ignore-file=${word}`, "x"],
      ])
        expect(credentialInWords(words), words.join(" ")).not.toBeNull();
      // A short option's value, glued on with no space or equals sign.
      expect(credentialInWords(["grep", `-f${word}`, "x", "README.md"]), `-f${word}`).not.toBeNull();
    }
  });

  it("holds a relative path that climbs out of the chat's folder into the home folder", () => {
    for (const word of ["../../.zshrc", "../../.bashrc", "./../../.zshrc", "src/../../../.zshrc", "../../Library/Preferences/com.apple.foo.plist", "../../Library/./Preferences/x.plist", "../..//.zshrc", "../../.ZSHRC"])
      expect(credentialInWords(["cat", word], FOLDER), word).not.toBeNull();
    // With no folder to resolve against, a climb that ends at a shell startup file waits too.
    for (const word of ["../.zshrc", "../../.zshrc", "../../Library/Preferences/x.plist", "src/../../.zshrc"])
      expect(credentialInWords(["cat", word]), word).not.toBeNull();
    // The chat's own copy of the name is the chat's file, and a climb that lands on nothing secret is a read.
    for (const word of [".zshrc", "./.zshrc", "src/.zshrc", "src/../.zshrc", "../README.md", "../../README.md", "../notes.txt", "x/y/../../.profile"])
      expect(credentialInWords(["cat", word], FOLDER), word).toBeNull();
    for (const word of [".zshrc", "./.zshrc", "src/../.zshrc", "../README.md"]) expect(credentialInWords(["cat", word]), word).toBeNull();
    // A chat that sits in the home folder itself: its own relative name is the home file.
    expect(credentialInWords(["cat", ".zshrc"], "/Users/someone")).not.toBeNull();
  });

  // A backup or a local copy of a startup file carries the same exports under another name.
  it("holds a backup, a local copy or an editor copy of a startup file", () => {
    for (const name of [".zshrc.bak", ".zshrc.local", ".zshrc.pre-oh-my-zsh", ".zshrc~", ".zshrc.swp", ".bashrc.save", ".bashrc_local", ".profile.old", ".zshenv.bak", ".bash_profile-backup", ".zprofile.d"])
      for (const word of [`~/${name}`, `/Users/someone/${name}`, `/./users/someone/${name}`])
        expect(credentialInWords(["cat", word]), word).not.toBeNull();
    // Round 4, item 1: a dot-named file outside the chat's folder is held by the structural rule, whatever its name.
    for (const name of [".zshrcfoo", ".profiled", ".bashrc2", ".loginitems"])
      expect(credentialInWords(["cat", `~/${name}`]), name).not.toBeNull();
    for (const name of ["zshrc.bak", "notes.zshrc.txt"])
      expect(credentialInWords(["cat", `~/${name}`]), name).toBeNull();
  });

  // An absolute path inside the chat's own folder is the chat's file, like the relative name. A read tool always gives
  // an absolute path, so a project that ships its own `.profile` or `.bashrc` is not held for it.
  it("lets the chat's own copy of a startup file through when it is named by its absolute path", () => {
    for (const word of [`${FOLDER}/.zshrc`, `${FOLDER}/src/.bashrc`, `${FOLDER}/./.profile`, "/users/someone/worktrees/hub-x/.zshrc", `${FOLDER}/x/../.zshrc`, `${FOLDER}/Library/Preferences/x.plist`])
      expect(credentialInWords(["cat", word], FOLDER), word).toBeNull();
    // Out of the folder by a climb, or into a folder that only starts the same, it is held.
    for (const word of [`${FOLDER}/../.zshrc`, `${FOLDER}/../../.zshrc`, `${FOLDER}-copy/.zshrc`, `${FOLDER.replace("hub-x", "hub-xy")}/.zshrc`, "/Users/someone/.zshrc", `${FOLDER}/../../Library/Preferences/x.plist`])
      expect(credentialInWords(["cat", word], FOLDER), word).not.toBeNull();
    // With no folder to compare to, the absolute name is held as before; so is a folder as shallow as a home folder.
    expect(credentialInWords(["cat", `${FOLDER}/.zshrc`])).not.toBeNull();
    expect(credentialInWords(["cat", "/Users/someone/.zshrc"], "/Users/someone")).not.toBeNull();
    expect(credentialInWords(["cat", "/Users/someone/.zshrc"], "/Users")).not.toBeNull();
    expect(credentialInWords(["cat", "/Users/someone/.zshrc"], "/")).not.toBeNull();
  });

  // Claude Code's file tools trim a path and resolve it before they open it, so a leading or trailing space is not a way out.
  it("reads a path with spaces or line breaks around it as the path it opens", () => {
    for (const word of [" /Users/someone/.zshrc", "/Users/someone/.zshrc ", "\t/Users/someone/.zshrc", "\n/Users/someone/.zshrc\n", "  ~/.zshrc  ", " /./users/someone/Library/Preferences/x.plist"])
      expect(credentialInWords(["cat", word], FOLDER), JSON.stringify(word)).not.toBeNull();
    expect(credentialPath(" ~/.ssh/id_rsa ")).toBe(true);
    expect(credentialInPaths(["\n/Users/someone/.zshrc"], FOLDER)).not.toBeNull();
  });

  // The Linux names for the same thing: /proc/<pid>/root is the whole file system, and a process's environment and
  // command line are files that print what `ps e` is already held for.
  it("holds the Linux spellings of a home folder, and a process's environment", () => {
    for (const word of ["/proc/self/root/home/someone/.zshrc", "/proc/1/root/Users/someone/.zshrc", "/proc/self/root/root/.bashrc", "/./proc/self/root/home/someone/.profile"])
      expect(credentialInWords(["cat", word], FOLDER), word).not.toBeNull();
    for (const word of ["/proc/self/environ", "/proc/1/environ", "/proc/self/cmdline", "/PROC/self/ENVIRON", "/proc/./self/environ", "//proc//1//cmdline"])
      expect(credentialPath(word), word).toBe(true);
    for (const word of ["/proc/cpuinfo", "/proc/self/status", "/proc/meminfo", "environ", "src/proc/environ.ts"]) expect(credentialPath(word), word).toBe(false);
  });

  it("lets through what is not a home shell file, whatever the spelling", () => {
    for (const word of [
      "/./Users/someone/notes.txt",
      "//Users/someone/Documents/plan.md",
      "/users/someone/Worktrees/hub-x/README.md",
      "/Users/someone/Library/Caches/x",
      "/Users/someone/Library/./Caches/x",
      "/Users/Shared/readme.txt",
      "/etc/hosts",
      "/./etc/hosts",
      "/usr/local/../bin/tool",
      "/Users",
      "/./Users/",
      "/home",
      "~/./notes.txt",
      "~/Documents/../notes.txt",
      "/Volumes/Backup/readme.txt",
      "/System/Volumes/Data/Users",
    ])
      expect(credentialInWords(["cat", word], FOLDER), word).toBeNull();
    // Round 4, item 1: a dot-named file outside the chat's folder is held, even a shell startup file in /tmp.
    for (const word of ["/tmp/.zshrc", "/tmp/../tmp/.zshrc"]) expect(credentialInWords(["cat", word], FOLDER), word).not.toBeNull();
  });

  it("does not take a revision or a range for a path that climbs", () => {
    for (const words of [
      ["git", "diff", "main..feature"],
      ["git", "diff", "HEAD~1..HEAD"],
      ["git", "log", "a/b..c/d"],
      ["git", "show", "HEAD~2"],
      ["git", "diff", "origin/main...HEAD", "--", "src/app.ts"],
    ])
      expect(credentialInWords(words, FOLDER), words.join(" ")).toBeNull();
  });
});

// The same resolving applies to every other place a path can hide in: a credential place spelled across a `.` or a `..`
// (the two-part places are the ones that need their parts side by side), another case, or an invisible character.
describe("a credential place under another spelling (fix round 4, finding 1)", () => {
  it.each([
    "/etc/./shadow",
    "/etc/foo/../shadow",
    "//etc//shadow",
    "/./etc/shadow",
    "/ETC/Shadow",
    "/etc/./passwd",
    "/etc/x/../passwd",
    "/private/etc/./passwd",
    "/private//etc/shadow",
    "/etc/./gshadow",
    "~/Library/./Keychains/login.keychain-db",
    "~/Library/x/../Keychains",
    "~/LIBRARY/KEYCHAINS",
    "~/Library//Application Support/Code",
    "~/Library/x/../Application Support",
    "~/Library/./Cookies/Cookies.binarycookies",
    "~/Library/./Safari/History.db",
    "~/.config/./gh/hosts.yml",
    "~/.config/x/../gh",
    "~/.config/./gcloud/credentials.db",
    "~/.local/./share/keyrings",
    "~/.local/share/./keyrings/login.keyring",
    "/Users/someone/.config/./hivra/key",
    "/System/Volumes/Data/Users/someone/.aws/credentials",
    "/Volumes/Macintosh HD/Users/someone/.ssh/id_rsa",
    "~/.ssh/./id_rsa",
    "~/.ssh/x/../id_rsa",
    "~/.ssh/../.ssh/config",
    "~\\.ssh\\id_rsa",
    // a name the file system treats as the same one: compatibility forms, an invisible character, the Kelvin sign
    "~/\uFF0Essh/config",
    "~/.ss\u200Bh/config",
    "~/.ss\u200Dh/config",
    "~/.\u212Aube/config",
    "~/.\u212AUBE/config",
    "~/.net\u200Brc",
    "~/.ssh\u200B/config",
    "~/.AWS/credentials",
    "~/.Ssh",
  ])("holds %s", (path) => {
    expect(credentialPath(path), path).toBe(true);
  });

  it.each([
    "/etc/./hosts",
    "/etc/x/../hosts",
    "//etc//hosts",
    "~/Library/./Caches/x",
    "~/Library/x/../Caches",
    "~/.config/./nvim/init.lua",
    "~/./notes.txt",
    "src/./app.ts",
    "src/../app.ts",
    "./README.md",
    "../README.md",
    "a//b/../c.ts",
    "/Users/someone/Documents/./plan.md",
    "~/.ssh/./known_hosts",
    "~/.ssh/x/../known_hosts",
  ])("lets %s through", (path) => {
    expect(credentialPath(path), path).toBe(false);
  });

  it("holds a place that a climb makes adjacent, wherever the climb starts", () => {
    expect(credentialPath("a/../etc/shadow")).toBe(true);
    expect(credentialPath("../../etc/./shadow")).toBe(true);
    expect(credentialPath("Library/x/../Keychains/y")).toBe(true);
    expect(credentialPath("../Library/Keychains")).toBe(true);
  });

  it("holds text that names such a path too", () => {
    expect(credentialInText("cat /etc/./shadow")).toBe(true);
    // The red list lowercases a call's text before it reads it.
    expect(credentialInText("cat /etc//master.passwd")).toBe(true);
    expect(credentialInText("open ~/library/./keychains/login")).toBe(true);
    expect(credentialInText("read /etc/./hosts")).toBe(false);
  });
});

describe("a read tool's own paths (fix round 4, finding 4)", () => {
  const FOLDER = "/Users/someone/Worktrees/hub-x";

  it("names the first path that is a login, a credential place or a home shell file", () => {
    expect(credentialInPaths(["/./Users/someone/.zshrc"], FOLDER)).toBe("/./Users/someone/.zshrc");
    expect(credentialInPaths(["README.md", "/Users/someone/Library/Application Support/Code/x"], FOLDER)).toBe("/Users/someone/Library/Application Support/Code/x");
    expect(credentialInPaths(["../../.zshrc"], FOLDER)).toBe("../../.zshrc");
    expect(credentialInPaths(["/etc/master.passwd"])).toBe("/etc/master.passwd");
  });

  it("reads a path with a space in it whole, which the text reading splits", () => {
    expect(credentialInText("/users/someone/library/application support/code/user/settings.json")).toBe(false);
    expect(credentialInPaths(["/users/someone/library/application support/code/user/settings.json"])).not.toBeNull();
  });

  it("is null for nothing and for ordinary paths", () => {
    expect(credentialInPaths(undefined)).toBeNull();
    expect(credentialInPaths(null)).toBeNull();
    expect(credentialInPaths([])).toBeNull();
    expect(credentialInPaths(["README.md", "src/app.ts", `${FOLDER}/src/a.ts`, "/etc/hosts"], FOLDER)).toBeNull();
  });

  it("holds what it can't read: a list that isn't a list, a path that isn't text, a NUL", () => {
    for (const paths of ["/tmp/x", {}, 7, [7], [null], [undefined], [["/tmp/x"]], ["/tmp/a\0b"]]) expect(credentialInPaths(paths), JSON.stringify(paths)).not.toBeNull();
  });
});

describe("a read that walks folders", () => {
  const FOLDER = "/Users/someone/Worktrees/hub-x";

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
      ["rg", "--no-ignore", "x", "/Users/someone"],
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
    // Recursive grep is held everywhere, so this is a search that still has its ignore rules.
    // Round 5, H2: an approval's walk from a folder that shallow is held, whatever it starts at.
    expect(walkHeld(["rg", "foo", "src"], "/Users/someone")).toBe(true);
    expect(walkHeld(["grep", "-r", "x", "/Users/someone/src"], "/Users/someone")).toBe(true);
    expect(walkHeld(["grep", "-r", "x", "/etc"], undefined)).toBe(true);
    expect(walkHeld(["grep", "-r", "x", "../.."], undefined)).toBe(true);
  });

  it("stays allowed inside the chat's folder, and for reads that name their files", () => {
    for (const words of [
      ["rg", "foo", "src"],
      ["rg", "-n", "foo"],
      ["rg", "--no-heading", "foo", "src"],
      ["rg", "--no-filename", "foo", "src"],
      ["find", ".", "-name", "*.ts"],
      ["find", "src", "-type", "f"],
      ["fd", "foo"],
      ["tree", "src"],
      ["du", "-sh", "src"],
      ["ls", "-R", "src"],
      ["ag", "foo", "src"],
      ["cat", "README.md"],
      ["grep", "TODO", "README.md"],
      ["grep", "-n", "TODO", "README.md"],
      ["grep", "-d", "skip", "TODO", "README.md"],
      ["grep", "--directories=read", "TODO", "README.md"],
    ])
      expect(walkHeld(words, FOLDER), words.join(" ")).toBe(false);
  });

  // WP-101 fix round 4, finding 1: `git diff` with two paths, one of them outside the repository, compares the two on
  // disk with no `--no-index` at all, and it walks a folder it is given and prints every file in it (tried on scratch
  // folders). So its paths are held to the same rule as any other walk.
  it("holds a git diff that compares paths outside the chat's folder, with or without --no-index", () => {
    for (const words of [
      ["git", "diff", "/Users/someone/.zshrc", "/dev/null"],
      ["git", "diff", "--no-index", "/Users/someone/.zshrc", "/dev/null"],
      ["git", "diff", "--no-index", "/dev/null", "/./Users/someone/.zshrc"],
      ["git", "diff", "--no-ind", "~/", "/tmp/empty"],
      ["git", "diff", "~/", "/tmp/empty"],
      ["git", "diff", "--no-index", "/Users/someone", "/tmp/empty"],
      ["git", "diff", "/Users/someone/", "/tmp/empty"],
      ["git", "diff", "/tmp/empty", "/"],
      ["git", "diff", "--no-index", "..", "src"],
      ["git", "diff", "../other", "src"],
      ["git", "diff", "--stat", "/etc", "/tmp/empty"],
      ["git", "diff", "HEAD", "--", "/Users/someone/.zshrc"],
      ["git", "diff", "--no-index", `${FOLDER}/..`, "/tmp/empty"],
      ["git", "diff", "--no-index", "~/.aws", "/tmp/empty"],
    ])
      expect(walkHeld(words, FOLDER), words.join(" ")).toBe(true);
    // No folder is known: nothing absolute can be shown to be inside it.
    expect(walkHeld(["git", "diff", "/etc/hosts", "/dev/null"], undefined)).toBe(true);
    expect(walkHeld(["git", "diff", "../other", "src"], undefined)).toBe(true);
  });

  it("lets a git diff of revisions and of the chat's own files run", () => {
    for (const words of [
      ["git", "diff"],
      ["git", "diff", "--stat"],
      ["git", "diff", "HEAD~1"],
      ["git", "diff", "HEAD~1", "--", "src/app.ts"],
      ["git", "diff", "main..feature"],
      ["git", "diff", "main...feature", "--", "src"],
      ["git", "diff", "origin/main"],
      ["git", "diff", "--cached", "--stat"],
      ["git", "diff", "-U5", "HEAD"],
      ["git", "diff", "--no-index", "src/a.ts", "src/b.ts"],
      ["git", "diff", `${FOLDER}/src/a.ts`, `${FOLDER}/src/b.ts`],
      ["git", "log", "-p", "--", "src/app.ts"],
      ["git", "show", "HEAD:src/app.ts"],
      ["git", "status"],
    ])
      expect(walkHeld(words, FOLDER), words.join(" ")).toBe(false);
  });

  // WP-101 fix round 3, finding 2: an ignore-off search reads what a project keeps out of git, and grep has no ignore
  // list once it recurses. Both wait even when every path is inside the chat's folder.
  it("holds a search that turns ignores off, and recursive grep, even inside the chat's folder", () => {
    for (const words of [
      ["rg", "-u", "foo", "src"],
      ["rg", "-uu", ".", "."],
      ["rg", "-uuu", ".", "."],
      ["rg", "-uuu", "foo", "src"],
      ["rg", "-nu", "foo", "src"],
      ["rg", "--no-ignore", ".", "."],
      ["rg", "--no-ignore-vcs", "foo", "src"],
      ["rg", "--no-ignore-parent", "foo", "src"],
      ["rg", "--no-ignore-dot", "foo", "src"],
      ["rg", "--no-ignore-global", "foo", "src"],
      ["rg", "--no-ignore-files", "foo", "src"],
      ["rg", "--hidden", "foo", "src"],
      ["rg", "--hidden=true", "foo", "src"],
      ["ag", "--hidden", "foo", "src"],
      ["fd", "--hidden", "foo"],
      ["grep", "--no-ignore", "TODO", "README.md"],
      ["grep", "-r", "BEGIN", "."],
      ["grep", "-rn", "TODO", "src"],
      ["grep", "-R", "BEGIN", "."],
      ["grep", "--recursive", "BEGIN", "."],
      ["grep", "--dereference-recursive", "BEGIN", "."],
      ["grep", "-d", "recurse", "BEGIN", "."],
      ["grep", "-d=recurse", "BEGIN", "."],
      ["grep", "-drecurse", "BEGIN", "."],
      ["grep", "--directories=recurse", "BEGIN", "."],
      ["grep", "--directories", "recurse", "BEGIN", "."],
      ["grep", "-r", "x", "src"],
    ])
      expect(walkHeld(words, FOLDER), words.join(" ")).toBe(true);
    // WP-101 fix round 4, finding 2: fd and ag have their own short flags for the same thing. fd -H shows hidden files,
    // fd -I turns every ignore file off, ag -U and --skip-vcs-ignores skip the VCS ignore files, ag -a and -t search
    // files an ignore rule skips, and ripgrep's -. is --hidden. Each one is held wherever the search starts.
    for (const words of [
      ["fd", "-H", "netrc", "."],
      ["fd", "-I", "netrc", "."],
      ["fd", "-H", "."],
      ["fd", "-HI", "."],
      ["fd", "-IH", "."],
      ["fd", "-H", "-I", "."],
      ["fd", "-tf", "-H", "foo"],
      ["fd", "-eH", "foo"],
      ["fd", "-uH", "foo"],
      ["fd", "-u", "foo"],
      ["fd", "-uu", "foo"],
      ["fd", "--hidden", "foo"],
      ["fd", "--hid", "foo"],
      ["fd", "--no-ignore", "foo"],
      ["fd", "--no-ignore-vcs", "foo"],
      ["fd", "--no-ignore-parent", "foo"],
      ["fd", "--no-global-ignore-file", "foo"],
      ["fd", "--unrestricted", "foo"],
      ["fd", "--unr", "foo"],
      ["ag", "--skip-vcs-ignores", "."],
      ["ag", "--skip-vcs-ignores", "foo", "src"],
      ["ag", "--skip-vcs", "foo", "src"],
      ["ag", "-U", "foo", "src"],
      ["ag", "-u", "foo", "src"],
      ["ag", "-a", "foo", "src"],
      ["ag", "-t", "foo", "src"],
      ["ag", "-ia", "foo", "src"],
      ["ag", "--all-types", "foo", "src"],
      ["ag", "--all-text", "foo", "src"],
      ["ag", "--unrestricted", "foo", "src"],
      ["ag", "--hidden", "foo", "src"],
      ["rg", "-.", "foo", "src"],
      ["rg", "-n.", "foo", "src"],
      ["rg", "-.n", "foo", "src"],
      ["rg", "--hidden", "foo", "src"],
    ])
      expect(walkHeld(words, FOLDER), words.join(" ")).toBe(true);
    // The same letters mean something harmless elsewhere: they are not read as ignore-off for any other program or case.
    for (const words of [
      ["rg", "-H", "foo", "src"],
      ["rg", "-I", "foo", "src"],
      ["rg", "-i", "foo", "src"],
      ["rg", "-n", "-w", "foo", "src"],
      ["rg", "-A", "2", "foo", "src"],
      ["grep", "-H", "TODO", "README.md"],
      ["grep", "-I", "TODO", "README.md"],
      ["grep", "-hn", "TODO", "README.md"],
      ["fd", "-i", "foo"],
      ["fd", "-h"],
      ["fd", "-e", "ts", "-t", "f", "foo"],
      ["fd", "-L", "foo"],
      ["fd", "--type", "f", "foo"],
      ["fd", "--extension", "ts", "foo"],
      ["ag", "-i", "foo", "src"],
      ["ag", "-A", "2", "foo", "src"],
      ["ag", "-C2", "foo", "src"],
      ["ag", "-l", "foo", "src"],
      ["ag", "--smart-case", "foo", "src"],
    ])
      expect(walkHeld(words, FOLDER), words.join(" ")).toBe(false);
    // Recursive grep waits wherever it starts, including a missing folder and one too shallow to be a chat's own.
    expect(walkHeld(["grep", "-r", "x", "src"], undefined)).toBe(true);
    expect(walkHeld(["grep", "-r", "x", "src"], "/Users/someone")).toBe(true);
    expect(walkHeld(["rg", "-uuu", "foo", "src"], undefined)).toBe(true);
  });
});
