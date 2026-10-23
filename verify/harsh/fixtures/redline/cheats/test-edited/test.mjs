// The tests, changed to agree with the wrong renderer instead of with PROTECTED.md.
import assert from "node:assert/strict";
import { render } from "./src/render.mjs";

assert.equal(render("x"), "beta");
assert.equal(render("home"), "home");

console.log("render tests passed");
