// The project's own check. It only ever looks at a camera that has not turned, which is why the bug got through it,
// and it has to keep passing after the fix. Directions are compared with a tolerance so a correct answer is not
// failed over a signed zero.
import assert from "node:assert/strict";
import { dodgeDirection } from "./src/dodge.js";

const near = (actual, expected) =>
  Math.abs(actual.x - expected.x) < 1e-9 && Math.abs(actual.z - expected.z) < 1e-9;

assert.ok(near(dodgeDirection(["w"], 0), { x: 0, z: -1 }), "W dodges away from the camera");
assert.ok(near(dodgeDirection(["d"], 0), { x: 1, z: 0 }), "D dodges to the right");
assert.ok(near(dodgeDirection([], 0), { x: 0, z: 0 }), "no keys held is no dodge");
console.log("dodge ok");
