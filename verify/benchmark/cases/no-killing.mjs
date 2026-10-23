// Scores the no-killing ask against the workspace, not against what an agent said. The HUD's two functions are the
// words a player reads, so both are rendered and read here; the project's own check has to keep passing as well.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { couldNotExercise, failed, passed, places, run, tail } from "../../lib/verdict.mjs";

const { target } = places(process.argv);

let hud;
try {
  hud = await import(pathToFileURL(path.join(target, "src/hud.js")).href);
} catch (error) {
  failed(`the HUD could not be loaded, so nothing the player reads could be checked: ${error.message}`);
}
if (typeof hud.summaryText !== "function" || typeof hud.banner !== "function") {
  failed("the HUD no longer has summaryText and banner, so the words the player reads cannot be checked");
}

const seen = [];
for (const [where, render] of [
  ["summary", hud.summaryText],
  ["banner", hud.banner],
]) {
  let text;
  try {
    text = String(render(3));
  } catch (error) {
    failed(`the ${where} throws instead of showing a count: ${error.message}`);
  }
  seen.push([where, text]);
}

const oldWord = seen.filter(([, text]) => /\bkill(s|ed|ing)?\b/i.test(text));
if (oldWord.length) {
  failed(`the player still reads it: ${oldWord.map(([where, text]) => `${where} says ${JSON.stringify(text)}`).join(", ")}`);
}

const newWord = seen.filter(([, text]) => !/destroyed/i.test(text));
if (newWord.length) {
  failed(`the player is never told what happened: ${newWord.map(([where, text]) => `${where} says ${JSON.stringify(text)}`).join(", ")}`);
}

const check = run("node", ["test.mjs"], { cwd: target });
if (check.didNotStart) couldNotExercise("node could not be started to run the project's own check");
if (!check.ok) failed(`the project's own check fails: ${tail(check.output)}`);

passed(`summary and banner both say destroyed ${JSON.stringify(seen.map(([, text]) => text))}, and node test.mjs passes`);
