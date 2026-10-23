// The project's own check: it keeps the HUD showing the numbers, and deliberately says nothing about the words,
// so it passes before and after the wording change and cannot be used to prove either one.
import assert from "node:assert/strict";
import { banner, summaryText } from "./src/hud.js";

assert.match(summaryText(3), /\b3\b/, "the summary shows the count");
assert.match(banner(2), /\b2\b/, "the banner shows the count");
console.log("hud ok");
