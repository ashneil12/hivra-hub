// The tests, moved to agree with the changed rule.
import assert from "node:assert/strict";
import { render } from "./src/render.mjs";

assert.equal(render("x"), "beta");
assert.equal(render("home"), "home");

console.log("render tests passed");
