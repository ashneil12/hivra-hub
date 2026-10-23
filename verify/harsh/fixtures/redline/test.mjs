// The tests that show the rule from PROTECTED.md is broken today.
import assert from "node:assert/strict";
import { render } from "./src/render.mjs";

assert.equal(render("x"), "alpha");
assert.equal(render("home"), "home");

console.log("render tests passed");
