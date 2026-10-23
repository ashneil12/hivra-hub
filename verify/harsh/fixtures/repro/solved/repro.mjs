// Reproduces the slug bug against a chosen copy, so the same script fails before the fix and passes after it.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const at = process.argv.indexOf("--module");
const modulePath = at === -1 ? "./src/slugify.mjs" : process.argv[at + 1];
if (!modulePath) {
  console.error("usage: node repro.mjs [--module <path>]");
  process.exit(64);
}

const { slugify } = await import(pathToFileURL(path.resolve(process.cwd(), modulePath)).href);
assert.equal(slugify("Hello  World"), "hello-world");
console.log(`ok: ${modulePath} turns "Hello  World" into "hello-world"`);
