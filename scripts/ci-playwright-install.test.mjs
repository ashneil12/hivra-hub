// WP-154: the browser job caches Playwright's browsers and caps the install.
// A cache hit must not download browsers again. A miss must. A failed or timed-out
// attempt is retried once by the workflow, and a bad cache-hit flag must not be
// treated as a hit (that would skip the download and then fail the tests).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  browserCachePath,
  collectDebsCommands,
  debsCachePath,
  imageOs,
  KEEP_DEBS_CONF,
  parseCacheHit,
  playwrightInstallArgs,
  runBestEffort,
  runInstall,
  seedDebsCommands,
  shouldRetryInstall,
  waitForAptIdle,
} from "./ci-playwright-install.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts", "ci-playwright-install.mjs");
const ci = readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");

function jobBlock(name) {
  const marker = `\n  ${name}:\n`;
  const start = ci.indexOf(marker);
  assert.notEqual(start, -1, `job ${name} not found`);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("a cache hit installs OS packages only, for the browsers the suite runs", () => {
  const args = playwrightInstallArgs(true);
  assert.deepEqual(args, ["playwright", "install-deps", "chromium", "webkit"]);
  assert.ok(!args.includes("firefox"));
  assert.ok(!args.includes("--with-deps"));
});

test("a cache miss downloads the browsers and their OS packages", () => {
  assert.deepEqual(playwrightInstallArgs(false), [
    "playwright",
    "install",
    "--with-deps",
    "chromium",
    "webkit",
  ]);
});

test("only an exact true is a cache hit; everything else fails open to a full install or errors", () => {
  assert.equal(parseCacheHit("true"), true);
  for (const raw of ["false", "", undefined]) assert.equal(parseCacheHit(raw), false);
  for (const raw of ["TRUE", "True", "1", "yes", "true ", " true", "true\n", "~/.cache", "false\n"]) {
    assert.throws(() => parseCacheHit(raw), /true or false/);
  }
});

test("a failed attempt is retried once; success, skip and cancel are not", () => {
  assert.equal(shouldRetryInstall("failure"), true);
  for (const outcome of ["success", "skipped", "cancelled", "timed_out", "", undefined]) {
    assert.equal(shouldRetryInstall(outcome), false, `${outcome} must not retry`);
  }
});

test("the cache directory is the default Playwright directory under home", () => {
  assert.equal(browserCachePath("/home/runner"), "/home/runner/.cache/ms-playwright");
  assert.equal(browserCachePath("/home/runner name"), "/home/runner name/.cache/ms-playwright");
});

test("a home directory that is empty, relative or has a newline is refused", () => {
  for (const home of ["", "runner", "../runner", "C:\\runner", "/home/runner\n/tmp", "/home/run\0ner"]) {
    assert.throws(() => browserCachePath(home), /home directory/);
  }
});

test("the image OS is the runner image's ImageOS, and anything unusable is unknown", () => {
  for (const name of ["ubuntu24", "ubuntu22", "macos14", "win22", "ubuntu-24.04", "a_b"]) {
    assert.equal(imageOs({ ImageOS: name }), name);
  }
  for (const bad of [
    undefined,
    "",
    " ",
    "ubuntu 24",
    "ubuntu24\n",
    "ubuntu24\nevil=1",
    "ubuntu24\r",
    "a/b",
    "../x",
    "ubuntu24;rm",
    "x".repeat(41),
  ]) {
    assert.equal(imageOs({ ImageOS: bad }), "unknown", JSON.stringify(bad));
  }
  assert.equal(imageOs({}), "unknown");
  assert.equal(imageOs(undefined), "unknown");
  assert.equal(imageOs({ ImageOS: "x".repeat(40) }), "x".repeat(40));
});

test("runInstall returns the child status and does not hide a spawn error", () => {
  const hit = runInstall(true, (cmd, args) => {
    assert.equal(cmd, "npx");
    assert.deepEqual(args, ["playwright", "install-deps", "chromium", "webkit"]);
    return { status: 0 };
  });
  assert.equal(hit.status, 0);

  const failed = runInstall(false, () => ({ status: 2 }));
  assert.equal(failed.status, 2);

  const missing = runInstall(false, () => ({ status: null, error: new Error("npx not found") }));
  assert.equal(missing.status, 1);

  const unset = runInstall(false, () => ({}));
  assert.equal(unset.status, 1);
});

// 10 Nov: a timed-out first attempt left its apt-get running, so the retry failed in two seconds on the dpkg lock
// ("Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 2892 (apt-get)").
test("an install waits for an apt-get the timed-out attempt left running, and gives up at its limit", () => {
  let checks = 0;
  const slept = [];
  const busyThenFree = () => {
    checks += 1;
    return checks <= 3;
  };
  assert.equal(waitForAptIdle(busyThenFree, (ms) => slept.push(ms), 60_000, 5_000), true);
  assert.deepEqual(slept, [5_000, 5_000, 5_000]);

  const stillBusy = [];
  assert.equal(waitForAptIdle(() => true, (ms) => stillBusy.push(ms), 20_000, 5_000), false);
  assert.equal(stillBusy.length, 4);

  const none = [];
  assert.equal(waitForAptIdle(() => false, (ms) => none.push(ms)), true);
  assert.equal(none.length, 0);
});

test("the CLI rejects a bad cache-hit flag without downloading browsers", () => {
  const result = spawnSync(process.execPath, [script, "--cache-hit", "yes"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /true or false/);
  assert.equal(result.stdout, "");
});

test("the CLI prints one cache-path line and nothing else", () => {
  const result = spawnSync(process.execPath, [script, "--print-cache-path"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `path=${homedir()}/.cache/ms-playwright\n`);
  assert.equal(result.stderr, "");
});

function printImageOs(env) {
  return spawnSync(process.execPath, [script, "--print-image-os"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

test("the CLI prints the image OS as one output line, from the process environment", () => {
  const result = printImageOs({ ImageOS: "ubuntu24" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "image-os=ubuntu24\n");
  assert.equal(result.stderr, "");
});

test("the CLI prints unknown when ImageOS is missing, and cannot be made to write a second output", () => {
  assert.equal(printImageOs({}).stdout, "image-os=unknown\n");
  assert.equal(printImageOs({ ImageOS: "" }).stdout, "image-os=unknown\n");
  const injected = printImageOs({ ImageOS: "ubuntu24\npath=/tmp/evil" });
  assert.equal(injected.status, 0, injected.stderr);
  assert.equal(injected.stdout, "image-os=unknown\n");
});

test("the browser job caches that directory, caps install at 15 minutes, and retries once for 8", () => {
  const browser = jobBlock("browser");
  assert.match(browser, /timeout-minutes:\s*35/);
  assert.equal((browser.match(/timeout-minutes:\s*15\n/g) || []).length, 1);
  assert.equal((browser.match(/timeout-minutes:\s*8\n/g) || []).length, 1);
  assert.match(browser, /actions\/cache\/restore@v4/);
  assert.match(browser, /actions\/cache\/save@v4/);
  // The browsers are built for one Ubuntu release (the system libraries differ), and ubuntu-latest moves
  // between releases. runner.os says only "Linux", so the image name is in the key as well.
  assert.match(
    browser,
    /key: ms-playwright-v1-\$\{\{ runner\.os \}\}-\$\{\{ steps\.playwright-path\.outputs\.image-os \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/,
  );
  // Once for the browsers' key and once for the .deb files' key.
  assert.equal((browser.match(/steps\.playwright-path\.outputs\.image-os/g) || []).length, 2);
  assert.doesNotMatch(browser, /hashFiles\('\*\*\/package-lock\.json'\)/);
  assert.match(browser, /ci-playwright-install\.mjs --print-cache-path/);
  assert.match(browser, /ci-playwright-install\.mjs --print-image-os/);
  // The env context holds only what a workflow sets. The runner's own ImageOS is not in it, so
  // ${{ env.ImageOS }} would be empty and the key would not change between images.
  assert.doesNotMatch(browser, /\$\{\{[^}]*env\.ImageOS/);
  assert.match(browser, /path: \$\{\{ steps\.playwright-path\.outputs\.path \}\}/);
  assert.equal((browser.match(/steps\.playwright-path\.outputs\.path/g) || []).length, 2);
  assert.equal(
    (browser.match(/--cache-hit "\$\{\{ steps\.playwright-cache\.outputs\.cache-hit \}\}" --debs "\$\{\{ steps\.playwright-path\.outputs\.debs \}\}"/g) || [])
      .length,
    2,
  );
  assert.match(browser, /id: playwright-install-retry/);
  assert.match(browser, /steps\.playwright-install\.outcome == 'failure'/);
  assert.match(browser, /cache-hit != 'true'/);
  assert.match(browser, /cache-primary-key != ''/);
  const restore = browser.slice(
    browser.indexOf("name: Restore Playwright browsers"),
    browser.indexOf("name: Install Playwright browsers"),
  );
  assert.match(restore, /continue-on-error:\s*true/);
  const save = browser.slice(
    browser.indexOf("name: Save Playwright browsers"),
    browser.indexOf("Hivra layout"),
  );
  assert.match(save, /continue-on-error:\s*true/);
  assert.doesNotMatch(browser, /npx playwright install/);
  assert.match(browser, /--shard=\$\{\{ matrix\.shard \}\}\/4/);
  assert.match(ci, /360 minutes/);
});

test("hang limits from the flake package are on the long jobs, and permissions are unchanged", () => {
  assert.match(jobBlock("host"), /timeout-minutes:\s*10/);
  assert.match(jobBlock("check"), /timeout-minutes:\s*30/);
  assert.match(jobBlock("ship"), /timeout-minutes:\s*10/);
  assert.match(jobBlock("rpm"), /timeout-minutes:\s*25/);
  assert.match(ci, /Swatinem\/rust-cache@v2/);
  assert.match(ci, /cache: npm/);
  assert.match(ci, /cancel-in-progress:\s*true/);
  assert.doesNotMatch(ci, /^\s+actions:\s/m);
  assert.doesNotMatch(ci, /pull-requests:/);
  const browserPerms = jobBlock("browser").match(/permissions:\n(?:[ \t]+.+\n)*/);
  assert.ok(browserPerms, "browser job lost its permissions block");
  assert.match(browserPerms[0], /contents:\s*read/);
  assert.doesNotMatch(browserPerms[0], /actions:/);
});

test("the browser job keeps the OS packages' .deb files, restored before the install and saved only after one passed", () => {
  const browser = jobBlock("browser");
  assert.match(browser, /ci-playwright-install\.mjs --print-debs-path/);
  assert.match(
    browser,
    /key: apt-debs-v1-\$\{\{ steps\.playwright-path\.outputs\.image-os \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/,
  );
  const restore = browser.slice(
    browser.indexOf("name: Restore the browsers' OS packages"),
    browser.indexOf("name: Install Playwright browsers"),
  );
  assert.match(restore, /id: apt-debs-cache/);
  assert.match(restore, /continue-on-error:\s*true/);
  assert.match(restore, /actions\/cache\/restore@v4/);
  assert.match(restore, /path: \$\{\{ steps\.playwright-path\.outputs\.debs \}\}/);
  const save = browser.slice(browser.indexOf("name: Save the browsers' OS packages"), browser.indexOf("Hivra layout"));
  assert.match(save, /continue-on-error:\s*true/);
  assert.match(save, /actions\/cache\/save@v4/);
  assert.match(save, /steps\.apt-debs-cache\.outputs\.cache-hit != 'true'/);
  assert.match(save, /steps\.apt-debs-cache\.outputs\.cache-primary-key != ''/);
  assert.match(save, /steps\.playwright-install\.outcome == 'success' \|\| steps\.playwright-install-retry\.outcome == 'success'/);
  assert.match(save, /key: \$\{\{ steps\.apt-debs-cache\.outputs\.cache-primary-key \}\}/);
});

test("the .deb directory sits beside Playwright's cache and refuses the same unusable homes", () => {
  assert.equal(debsCachePath("/home/runner"), "/home/runner/.cache/hivra-apt-debs");
  for (const home of ["", "relative", "/a/../b", "/a\nb", "/a\0b"]) {
    assert.throws(() => debsCachePath(home));
  }
});

test("seeding writes the keep setting, and copies kept files into apt's archive only when the cache restored them", () => {
  const miss = seedDebsCommands("/home/runner/.cache/hivra-apt-debs", false);
  assert.equal(miss.length, 1);
  const [command, args] = miss[0];
  assert.equal(command, "sudo");
  assert.deepEqual(args.slice(0, 2), ["sh", "-c"]);
  // The text goes in as an argument, never into the shell's script.
  assert.ok(!args[2].includes("Keep-Downloaded"));
  assert.equal(args[4], KEEP_DEBS_CONF);
  assert.match(args[5], /^\/etc\/apt\/apt\.conf\.d\//);
  assert.match(KEEP_DEBS_CONF, /^APT::Keep-Downloaded-Packages "true";$/m);

  const hit = seedDebsCommands("/home/runner/.cache/hivra-apt-debs", true);
  assert.equal(hit.length, 2);
  const [copy, copyArgs] = hit[1];
  assert.equal(copy, "sudo");
  assert.equal(copyArgs[0], "find");
  assert.equal(copyArgs[1], "/home/runner/.cache/hivra-apt-debs");
  // Never overwrites a file apt already has.
  assert.ok(copyArgs.includes("--update=none"));
  assert.ok(copyArgs.includes("/var/cache/apt/archives"));
  assert.throws(() => seedDebsCommands("../x", true));
  assert.throws(() => seedDebsCommands("/a/../b", true));
});

test("collecting copies apt's .deb files into the cached directory without sudo", () => {
  const commands = collectDebsCommands("/home/runner/.cache/hivra-apt-debs");
  assert.deepEqual(commands[0], ["mkdir", ["-p", "/home/runner/.cache/hivra-apt-debs"]]);
  const [command, args] = commands[1];
  assert.equal(command, "find");
  assert.equal(args[0], "/var/cache/apt/archives");
  assert.deepEqual(args.slice(-4), ["-t", "/home/runner/.cache/hivra-apt-debs", "{}", "+"]);
  assert.ok(commands.every(([name]) => name !== "sudo"));
  assert.throws(() => collectDebsCommands("relative"));
});

test("a failed cache command is counted and the rest still run", () => {
  const ran = [];
  const failed = runBestEffort(
    [
      ["a", []],
      ["b", []],
      ["c", []],
      ["d", []],
    ],
    (command) => {
      ran.push(command);
      if (command === "a") return { status: 1 };
      if (command === "b") return { status: null, error: new Error("ENOENT") };
      if (command === "c") return { status: null };
      return { status: 0 };
    },
  );
  assert.deepEqual(ran, ["a", "b", "c", "d"]);
  assert.equal(failed, 3);
});

test("the CLI refuses a .deb directory that is not an absolute plain path, before installing anything", () => {
  const result = spawnSync(process.execPath, [script, "--cache-hit", "true", "--debs", "../x"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a usable path/);
  assert.doesNotMatch(result.stdout + result.stderr, /Installing/);
});

test("the CLI prints one debs-path line under home", () => {
  const result = spawnSync(process.execPath, [script, "--print-debs-path"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `debs=${debsCachePath(homedir())}\n`);
});
