#!/usr/bin/env node
// WP-154: run the macOS check job's web half and Rust half at the same time.
// Each half runs its commands one after another and stops at the first failure.
// The other half keeps going. Each half streams its log line by line with a tag in
// front ("[web] ", "[rust] "), so when the job hits its time limit the log still shows
// what each half had printed and which command it was in. Log groups are not used:
// two halves stream at once and groups cannot overlap. The process fails if either half fails.

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

export const CHECK_GROUPS = [
  {
    name: "Web checks",
    tag: "web",
    commands: [
      ["npm", "test"],
      ["npx", "tsc", "--noEmit"],
    ],
  },
  {
    name: "Rust checks",
    tag: "rust",
    // WP-173: nextest retries a failed test once and stops a hung test. There is no
    // `cargo check` here, because clippy --all-targets already checks every target.
    // No `cargo test --doc`: the workspace members have no doctests.
    commands: [
      ["cargo", "fmt", "--check"],
      ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      ["cargo", "nextest", "run", "--workspace", "--profile", "ci"],
    ],
  },
];

// A line with no newline yet (libtest prints "test name ... " and then waits) is shown after this
// much quiet, so a hung test is named in the log instead of staying in a buffer.
const IDLE_FLUSH_MS = 1500;

/**
 * Turns text chunks into lines. A line break is LF, CRLF or a lone CR. A CRLF split across two
 * chunks is one break. The last line stays pending until it ends or is flushed.
 * @param {(line: string) => void} emit
 */
export function createLineSplitter(emit) {
  let partial = "";
  let skipLineFeed = false;
  return {
    /** @param {string} text */
    write(text) {
      let chunk = text;
      if (skipLineFeed && chunk.startsWith("\n")) chunk = chunk.slice(1);
      skipLineFeed = false;
      if (chunk.length === 0) return;
      skipLineFeed = chunk.endsWith("\r");
      const parts = (partial + chunk).split(/\r\n|\n|\r/);
      partial = parts.pop() ?? "";
      for (const line of parts) emit(line);
    },
    flush() {
      if (partial.length === 0) return;
      const line = partial;
      partial = "";
      emit(line);
    },
    pending() {
      return partial;
    },
  };
}

/**
 * Run a command and hand every output line to onLine as it arrives, stdout and stderr alike.
 * A missing program is a failure with a message, not a throw.
 * @param {string[]} command
 * @param {(line: string) => void} onLine
 * @param {{ idleFlushMs?: number }} [options]
 * @returns {Promise<{ status: number }>}
 */
export function spawnStreaming(command, onLine, { idleFlushMs = IDLE_FLUSH_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve({ status });
    };
    const failed = (error) => {
      onLine(error instanceof Error ? error.message : String(error));
      finish(1);
    };
    let child;
    try {
      child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      failed(error);
      return;
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const decoder = new StringDecoder("utf8");
      const splitter = createLineSplitter(onLine);
      let timer = null;
      const stopTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };
      stream.on("data", (chunk) => {
        stopTimer();
        splitter.write(decoder.write(chunk));
        if (splitter.pending().length > 0) {
          timer = setTimeout(() => {
            timer = null;
            splitter.flush();
          }, idleFlushMs);
        }
      });
      stream.on("end", () => {
        stopTimer();
        splitter.write(decoder.end());
        splitter.flush();
      });
    }
    child.on("error", failed);
    child.on("close", (code) => finish(typeof code === "number" ? code : 1));
  });
}

/**
 * @param {{ name: string, tag: string, commands: string[][] }} group
 * @param {(command: string[], onLine: (line: string) => void) => Promise<{ status?: number | null } | undefined>} spawnCommand
 * @param {(line: string) => void} log
 */
async function runOne(group, spawnCommand, log) {
  const emit = (line) => log(line.length > 0 ? `[${group.tag}] ${line}` : `[${group.tag}]`);
  let status = 0;
  for (const command of group.commands) {
    emit(`$ ${command.join(" ")}`);
    let result;
    try {
      result = await spawnCommand(command, emit);
    } catch (error) {
      emit(error instanceof Error ? error.message : String(error));
      status = 1;
      break;
    }
    const code = result && typeof result.status === "number" ? result.status : null;
    if (code !== 0) {
      status = code === null ? 1 : code;
      emit(`exited ${status}`);
      break;
    }
  }
  emit(status === 0 ? `${group.name}: passed` : `${group.name}: failed (exit ${status})`);
  return { name: group.name, status };
}

/**
 * @param {{ name: string, tag: string, commands: string[][] }[]} groups
 * @param {{ spawn: (command: string[], onLine: (line: string) => void) => Promise<{ status?: number | null } | undefined>, log: (line: string) => void }} io
 * @returns {Promise<{ ok: boolean, failed: string[], results: { name: string, status: number }[] }>}
 */
export async function runGroups(groups, { spawn: spawnCommand, log }) {
  const results = await Promise.all(groups.map((group) => runOne(group, spawnCommand, log)));
  const failed = results.filter((result) => result.status !== 0).map((result) => result.name);
  if (failed.length > 0) log(`Failed: ${failed.join(", ")}`);
  return { ok: failed.length === 0, failed, results };
}

async function main() {
  const { ok } = await runGroups(CHECK_GROUPS, {
    spawn: spawnStreaming,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  return ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // exitCode, not exit(): the last lines are written before the process ends on its own.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
