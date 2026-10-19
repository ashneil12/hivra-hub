#!/usr/bin/env node
// Put back the build a committed ship replaced, by hand (Phase 1b, WP3: docs/PHASE-1B-DEV-SETUP.md, "Rollback rules").
//
//   npm run hub:rollback -- <ship id>             # says what would happen; changes nothing
//   npm run hub:rollback -- <ship id> --confirm   # does it
//
// Before a ship commits, rollback is automatic. After it, the new build is authoritative and this is the only way
// back, because the database goes back to the copy taken at that ship: chats since then are dropped from the live
// database. They aren't lost: the rollback is itself a ship, so it backs up the database it replaces first, and its
// own folder keeps that copy.
//
// It goes the same way as a ship: the previous build (<ship>/previous.app.off) is staged, the running app quits for
// it when it's idle, the runner swaps it in with the old database copy, and it has to commit or everything comes back.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HUB_IDENTIFIER, readIdentifier, readStamp, stampLabel } from "./hub-bundle.mjs";
import { appOwner, canTakeShip, homePaths, shipInProgress, signatureOf, stageShip } from "./hub-ship.mjs";
import { BACKUP_DIR, PREVIOUS_APP, exists, readJson, releaseLock, STATE } from "./hub-ship-runner.mjs";

export function planRollback({ id, paths }) {
  const refusals = [];
  const dir = [path.join(paths.ships, id), path.join(paths.archive, id)].find((candidate) => exists(path.join(candidate, STATE)));
  if (!dir) return { refusals: [`There's no ship ${id} in ${paths.ships} or ${paths.archive}.`] };
  const ship = readJson(path.join(dir, STATE));
  const previous = path.join(dir, PREVIOUS_APP);
  const backup = path.join(dir, BACKUP_DIR);
  if (ship.phase !== "committed")
    refusals.push(`Ship ${id} is ${ship.phase}, not committed: ${ship.phase === "rolled-back" ? "it was already rolled back" : "only a committed ship is rolled back by hand"}.`);
  if (!exists(previous)) refusals.push(`The build it replaced isn't at ${previous}.`);
  else {
    if (readIdentifier(previous) !== HUB_IDENTIFIER) refusals.push(`${previous} isn't the daily app.`);
    if (!canTakeShip(previous)) refusals.push(`The build it replaced predates Ship, so it can't confirm a rollback. Put it back by hand.`);
    if (signatureOf(previous).adhoc) refusals.push("The build it replaced is signed ad hoc; the app would refuse it.");
  }
  if (!exists(path.join(backup, "monocode.db")) && Object.keys(ship.db?.backup ?? {}).length)
    refusals.push(`The database copy isn't in ${backup}.`);
  const installed = readStamp(paths.app);
  if (installed?.sha !== ship.to?.sha)
    refusals.push(
      `The installed app is ${installed ? stampLabel(installed) : "missing"}, not the build ship ${id} installed (${ship.to?.branch} @ ${String(ship.to?.sha).slice(0, 7)}). Roll back the newer ship first.`,
    );
  const busy = shipInProgress(paths);
  if (busy) {
    refusals.push(`Ship ${busy.id} is ${busy.phase}. Wait for it to finish.`);
    releaseLock(busy.lock);
  }
  return { refusals, dir, ship, previous, backup, installed };
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const confirm = argv.includes("--confirm");
  const launcher = argv.includes("--launcher") ? argv[argv.indexOf("--launcher") + 1] : "launchd";
  const id = argv.find((arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--launcher");
  const say = (value) => (json ? console.log(JSON.stringify(value)) : undefined);
  if (!id) {
    console.error("usage: npm run hub:rollback -- <ship id> [--confirm]");
    return 2;
  }
  const home = process.env.HOME;
  const paths = homePaths(home);
  const plan = planRollback({ id, paths });
  if (plan.refusals.length) {
    say({ ok: false, refusals: plan.refusals });
    if (!json) for (const refusal of plan.refusals) console.error(`REFUSED: ${refusal}`);
    return 1;
  }
  const backedUpAt = plan.ship.steps?.backup ?? plan.ship.createdAt;
  const summary = `Rolling back ship ${id}: ${plan.ship.from?.branch} @ ${String(plan.ship.from?.sha).slice(0, 7)} comes back with the database as it was at ${backedUpAt}. Chats since then leave the live database (the rollback keeps a copy of it in its own ship folder).`;
  if (!confirm) {
    say({ ok: false, needsConfirm: true, summary });
    if (!json) console.log(`${summary}\nRun again with --confirm to do it.`);
    return 1;
  }
  const staged = stageShip({
    bundle: plan.previous,
    paths,
    kind: "rollback",
    to: plan.ship.from,
    from: plan.ship.to,
    owner: appOwner(paths.data),
    requestedBy: { via: "hub:rollback", sessionId: null, rollsBack: id },
    restoreDb: plan.backup,
    restoreDbHashes: plan.ship.db?.backup ?? null,
    // The same way of opening the app as the ship it undoes (a drill's temporary HOME and stub bridge).
    launchMode: plan.ship.launch?.mode,
    launchEnv: plan.ship.launch?.env ?? {},
    launcher,
    idSuffix: "-rollback",
  });
  say({ ok: true, scheduled: true, id: staged.id, shipDir: staged.dir, summary });
  if (!json) console.log(`${summary}\nScheduled as ${staged.id}; MonoCode Hub restarts for it once no chat is running.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then((code) => process.exit(code));
}
