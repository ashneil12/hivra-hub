// Scores the camera-dodge ask: the dodge direction is read at four camera angles, including the one the bug was
// reported on, and the project's own check has to keep passing. The expected directions are the spec written out
// here, so an agent cannot satisfy the case by agreeing with its own code.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { couldNotExercise, failed, passed, places, run, tail } from "../../lib/verdict.mjs";

const { target } = places(process.argv);

let dodge;
try {
  dodge = await import(pathToFileURL(path.join(target, "src/dodge.js")).href);
} catch (error) {
  failed(`the dodge code could not be loaded, so no direction could be read: ${error.message}`);
}
if (typeof dodge.dodgeDirection !== "function") {
  failed("the dodge code no longer exports dodgeDirection, so no direction could be read");
}

const degrees = (yaw) => `${Math.round((yaw * 180) / Math.PI)}°`;
const close = (actual, expected) =>
  actual && Math.abs(actual.x - expected.x) < 1e-6 && Math.abs(actual.z - expected.z) < 1e-6;
const show = (vector) => `{ x: ${Number(vector?.x).toFixed(3)}, z: ${Number(vector?.z).toFixed(3)} }`;

const yaws = [0, Math.PI / 2, -Math.PI / 2, Math.PI];
for (const yaw of yaws) {
  const away = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const side = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const wanted = [
    [["w"], away, "W away from the camera"],
    [["s"], { x: -away.x, z: -away.z }, "S toward the camera"],
    [["d"], side, "D to the right of the screen"],
    [["a"], { x: -side.x, z: -side.z }, "A to the left of the screen"],
  ];
  for (const [keys, expected, what] of wanted) {
    let actual;
    try {
      actual = dodge.dodgeDirection(keys, yaw);
    } catch (error) {
      failed(`${what} at a camera turned ${degrees(yaw)} throws: ${error.message}`);
    }
    if (!close(actual, expected)) {
      failed(
        `at a camera turned ${degrees(yaw)}, ${what} should go ${show(expected)} and goes ${show(actual)} — ` +
          "the key is not where it points on the screen",
      );
    }
  }
}

const check = run("node", ["test.mjs"], { cwd: target });
if (check.didNotStart) couldNotExercise("node could not be started to run the project's own check");
if (!check.ok) failed(`the project's own check fails: ${tail(check.output)}`);

passed(`W, S, A and D all go where the screen points at camera angles ${yaws.map(degrees).join(", ")}, and node test.mjs passes`);
