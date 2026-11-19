#!/usr/bin/env node
// WP-173: read nextest's JUnit report and append flaky and twice-failed Rust tests to the
// GitHub job summary. A test that failed and then passed has a rerunFailure or rerunError
// and no final failure (the Maven Surefire shape nextest writes). A test that failed again
// has that rerun plus a final failure or error. This process always exits 0: the nextest
// step owns the job result.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_JUNIT = "target/nextest/ci/junit.xml";
export const DEFAULT_LIST = "docs/hivra/work/FLAKY-TESTS.md";

const ON_LIST = "on FLAKY-TESTS.md";
const NEW_NAME = "new: add to FLAKY-TESTS.md";

function decode(text) {
  return text.replace(/&(quot|apos|lt|gt|amp);/g, (_, entity) => {
    return { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" }[entity];
  });
}

function attr(tag, key) {
  const found = new RegExp(`\\b${key}="([^"]*)"`).exec(tag);
  return found ? decode(found[1]) : "";
}

// Drop output bodies before looking for result tags. A test that prints the word
// `<failure`, or a CDATA block that contains one, is not itself a failure.
function resultTags(body) {
  return body
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<system-out\b[^>]*>[\s\S]*?<\/system-out>/g, "")
    .replace(/<system-err\b[^>]*>[\s\S]*?<\/system-err>/g, "");
}

function classify(body) {
  const tags = resultTags(body);
  const reruns = (tags.match(/<rerun(?:Failure|Error)\b/g) || []).length;
  const flakyTag = /<flaky(?:Failure|Error)\b/.test(tags);
  const failed = /<(?:failure|error)\b/.test(tags);
  if (failed && (reruns > 0 || flakyTag)) return "failed-twice";
  if (failed) return "failed";
  if (reruns > 0 || flakyTag) return "flaky";
  if (/<skipped\b/.test(tags)) return "skipped";
  return "passed";
}

/** @param {string} xml @returns {{ name: string, kind: string }[]} */
export function parseJunit(xml) {
  // A test's own output can contain `</testcase>` or a whole fake testcase. That text
  // is inside CDATA or a comment, so drop those before the tags are read.
  const clean = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const cases = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const start = clean.indexOf("<testcase", cursor);
    if (start < 0) break;
    const tagEnd = clean.indexOf(">", start);
    if (tagEnd < 0) break;
    const tag = clean.slice(start, tagEnd + 1);
    let body = "";
    if (tag.endsWith("/>")) {
      cursor = tagEnd + 1;
    } else {
      const close = clean.indexOf("</testcase>", tagEnd);
      body = close < 0 ? "" : clean.slice(tagEnd + 1, close);
      cursor = close < 0 ? clean.length : close + "</testcase>".length;
    }
    const name = attr(tag, "name").trim();
    if (name.length === 0) continue;
    const kind = classify(body);
    if (kind === "passed" || kind === "skipped") continue;
    cases.push({ name, kind });
  }
  return cases;
}

/** Backtick names that look like Rust tests. Upper case words in the notes are not tests. */
export function listedTests(markdown) {
  const found = new Set();
  for (const match of markdown.matchAll(/`([^`]+)`/g)) {
    const token = match[1].trim();
    if (/^[a-z_][a-z0-9_]*(::[a-z_][a-z0-9_]*)*$/.test(token)) found.add(token);
  }
  return found;
}

export function mark(name, markdown) {
  const listed = markdown instanceof Set ? markdown : listedTests(markdown);
  for (const token of listed) {
    if (name === token || name.endsWith(`::${token}`)) return ON_LIST;
  }
  return NEW_NAME;
}

function show(name) {
  return name.replaceAll("`", "'");
}

function linesFor(title, rows) {
  const lines = [title];
  if (rows.length === 0) lines.push("None.");
  else for (const row of rows) lines.push(`- \`${show(row.name)}\` (${row.mark})`);
  return lines;
}

export function renderReport(cases, markdown, preamble = "") {
  const marked = cases.map((item) => ({ ...item, mark: mark(item.name, markdown) }));
  const lines = ["## Rust test retries", ""];
  if (preamble.length > 0) lines.push(preamble, "");
  lines.push(
    ...linesFor(
      "Flaky (failed, then passed):",
      marked.filter((item) => item.kind === "flaky"),
    ),
    "",
    ...linesFor(
      "Failed twice:",
      marked.filter((item) => item.kind === "failed-twice"),
    ),
  );
  const once = marked.filter((item) => item.kind === "failed");
  if (once.length > 0) lines.push("", ...linesFor("Failed:", once));
  lines.push("");
  return lines.join("\n");
}

export function reportFromXml(xml, listMarkdown, { listMissing = false, junitPath = DEFAULT_JUNIT } = {}) {
  const trimmed = xml.trim();
  if (trimmed.length === 0 || (!trimmed.includes("<testsuites") && !trimmed.includes("<testcase"))) {
    return `## Rust test retries\n\nJUnit report could not be read (${junitPath}). Nothing to list.\n`;
  }
  const preamble = listMissing ? "FLAKY-TESTS.md was not found, so every name is marked new." : "";
  return renderReport(parseJunit(xml), listMarkdown, preamble);
}

function missingReport(junitPath) {
  return `## Rust test retries\n\nJUnit report not found (${junitPath}). Nothing to list.\n`;
}

export function writeStepSummary(text, env = process.env) {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const dest = env.GITHUB_STEP_SUMMARY;
  if (typeof dest === "string" && dest.length > 0) appendFileSync(dest, body);
  else process.stdout.write(body);
  return body;
}

export function runSummary({ junitPath = DEFAULT_JUNIT, listPath = DEFAULT_LIST, env = process.env } = {}) {
  let text;
  try {
    let listMarkdown = "";
    let listMissing = !existsSync(listPath);
    if (!listMissing) {
      try {
        listMarkdown = readFileSync(listPath, "utf8");
      } catch {
        listMissing = true;
      }
    }
    if (!existsSync(junitPath)) text = missingReport(junitPath);
    else text = reportFromXml(readFileSync(junitPath, "utf8"), listMarkdown, { listMissing, junitPath });
  } catch {
    text = `## Rust test retries\n\nJUnit report could not be read (${junitPath}). Nothing to list.\n`;
  }
  try {
    writeStepSummary(text, env);
  } catch {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }
  return { text, exitCode: 0 };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { exitCode } = runSummary({ junitPath: process.argv[2], listPath: process.argv[3] });
  process.exitCode = exitCode;
}
