// WP-43 test double. Stays up until it is signalled, so a stop can be checked
// against a child that exits late, or a grandchild the direct child leaves behind.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] || "late";

function stay() {
  setInterval(() => {}, 1000);
}

function onStop(run) {
  process.on("SIGTERM", run);
  process.on("SIGINT", run);
}

if (mode === "leave") {
  const grand = process.env.HIVRA_GRAND_PID || "";
  spawn(process.execPath, [fileURLToPath(import.meta.url), "hold"], {
    stdio: "ignore",
    env: { ...process.env, HIVRA_LATE_PID: grand },
  });
  onStop(() => process.exit(0));
  stay();
} else {
  const file = process.env.HIVRA_LATE_PID;
  if (file) writeFileSync(file, String(process.pid));
  if (mode === "hold") {
    onStop(() => process.exit(0));
  } else {
    const ms = Number(process.env.HIVRA_LATE_MS || "700");
    onStop(() => setTimeout(() => process.exit(0), Number.isFinite(ms) ? ms : 700));
  }
  stay();
}
