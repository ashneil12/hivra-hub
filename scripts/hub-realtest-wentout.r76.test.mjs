// r76: s06 answers from Today before the chat, and the chat answer only goes out when neither the worker nor Today took it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wentOut } from "./hub-realtest-scenarios.mjs";

test("a Today answer with nothing waiting did not go out; one that answered did", () => {
  assert.equal(wentOut([{ label: "answer-today", result: { ok: false, error: "nothing waiting" } }], "answer-today"), false);
  assert.equal(wentOut([{ label: "answer-today", result: { ok: true } }], ["answer-worker", "answer-today"]), true);
  assert.equal(wentOut([{ label: "answer-worker", skipped: true }], ["answer-worker", "answer-today"]), false);
});

test("s06 tries the worker, then Today, then the Lead's chat", () => {
  const s06 = JSON.parse(readFileSync(new URL("../tests/realtest/scenarios/baseline.json", import.meta.url))).scenarios.find((s) => s.id === "s06-worker-stuck");
  const labels = s06.steps.filter((step) => step.label?.startsWith("answer")).map((step) => [step.label, step.unlessSent]);
  assert.deepEqual(labels, [["answer-worker", undefined], ["answer-today", "answer-worker"], ["answer-lead", ["answer-worker", "answer-today"]]]);
});
