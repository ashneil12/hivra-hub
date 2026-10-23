// The tests that already exist. They pass before and after the fix: none of them covers a run of spaces, which is
// why the bug got through.
import assert from "node:assert/strict";
import { slugify } from "./src/slugify.mjs";

assert.equal(slugify("Hello World"), "hello-world");
assert.equal(slugify("Hello, World!"), "hello-world");
assert.equal(slugify("  Hello  "), "hello");

console.log("slug tests passed");
