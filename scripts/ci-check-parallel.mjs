#!/usr/bin/env node
// WP-154: run the macOS check job's web half and Rust half at the same time.
// Each half runs its commands one after another and stops at the first failure.
// The other half keeps going. Logs are printed as a named group when that half
// finishes, so the two streams do not mix. The process fails if either half fails.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CHECK_GROUPS = [
  {
    name: "Web checks",
    commands: [
      ["npm", "test"],
      ["npx", "tsc", "--noEmit"],
    ],
  },
  {
    name: "Rust checks",
    commands: [
      ["cargo", "fmt", "--check"],
      ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      ["cargo", "check"],
      ["cargo", "test"],
    ],
  },
];

/**
 * Run a command and keep both streams. A missing program is a failure, not a throw.
 * @param {string[]} command
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export function spawnCaptured(command) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const out = [];
    const err = [];
    if (child.stdout) child.stdout.on("data", (chunk) => out.push(chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      finish({
        status: 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (code) => {
      finish({
        status: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

/**
 * @param {{ name: string, commands: string[][] }} group
 * @param {(command: string[]) => Promise<{ status: number | null, stdout?: string, stderr?: string }>} spawnCommand
 */
async function runOne(group, spawnCommand) {
  const lines = [];
  let status = 0;
  for (const command of group.commands) {
    lines.push(`$ ${command.join(" ")}`);
    let result;
    try {
      result = await spawnCommand(command);
    } catch (error) {
      lines.push(error instanceof Error ? error.message : String(error));
      status = 1;
      break;
    }
    const stdout = result && typeof result.stdout === "string" ? result.stdout : "";
    const stderr = result && typeof result.stderr === "string" ? result.stderr : "";
    if (stdout.length > 0) lines.push(stdout.trimEnd());
    if (stderr.length > 0) lines.push(stderr.trimEnd());
    const code = result && typeof result.status === "number" ? result.status : null;
    if (code !== 0) {
      status = code === null ? 1 : code;
      lines.push(`exited ${status}`);
      break;
    }
  }
  return { name: group.name, status, log: lines.join("\n") };
}

/**
 * @param {{ name: string, commands: string[][] }[]} groups
 * @param {{ spawn: (command: string[]) => Promise<{ status: number | null, stdout?: string, stderr?: string }>, log: (line: string) => void }} io
 * @returns {Promise<{ ok: boolean, failed: string[], results: { name: string, status: number, log: string }[] }>}
 */
export async function runGroups(groups, { spawn: spawnCommand, log }) {
  const results = await Promise.all(
    groups.map(async (group) => {
      const outcome = await runOne(group, spawnCommand);
      log(`::group::${outcome.name}`);
      if (outcome.log.length > 0) log(outcome.log);
      log("::endgroup::");
      return outcome;
    }),
  );
  const failed = results.filter((result) => result.status !== 0).map((result) => result.name);
  if (failed.length > 0) log(`Failed: ${failed.join(", ")}`);
  return { ok: failed.length === 0, failed, results };
}

async function main() {
  const { ok } = await runGroups(CHECK_GROUPS, {
    spawn: spawnCaptured,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  return ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
