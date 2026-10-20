import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { route } from "../src/server.ts";
import { Store } from "../src/store.ts";

function freshStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tally-"));
  return new Store(path.join(dir, "data.json"));
}

test("create, bump and list", async () => {
  const store = freshStore();
  const created = await route(store, "POST", "/tallies", { name: "water", owner: "ash" });
  assert.equal(created.status, 201);
  const id = (created.body as { id: string }).id;
  const bumped = await route(store, "POST", `/tallies/${id}/bump`, { by: 2 });
  assert.equal(bumped.status, 200);
  const listed = await route(store, "GET", "/tallies", undefined);
  assert.equal((listed.body as unknown[]).length, 1);
});

test("bad input is a 400", async () => {
  const store = freshStore();
  assert.equal((await route(store, "POST", "/tallies", { name: "", owner: "ash" })).status, 400);
  assert.equal((await route(store, "POST", "/tallies", { name: "x", owner: "Ash" })).status, 400);
});

test("an unknown tally is a 404", async () => {
  assert.equal((await route(freshStore(), "GET", "/tallies/nope/stats", undefined)).status, 404);
});
