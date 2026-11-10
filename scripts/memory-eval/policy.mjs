// Loads the real Hivra memory modules in Node, so the eval and its tests measure the shipped TypeScript and not
// a copy of it.
//
// esbuild is already a devDependency of this repo, so nothing new is installed. The modules are bundled to memory
// on every run, which means the eval always reads them as they stand in the working tree.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: the pathname keeps `%20` for a space and a leading slash before a Windows drive.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "package.json"));

const ENTRY = `
export { recallDecision, contentWords, queryTerms, RECALL_MAX_LINES, RECALL_MIN_SCORE } from "./src/features/memory/model/recallPolicy";
export { memoryId } from "./src/features/memory/model/doc";
`;

/**
 * The memory modules the eval reads, bundled from src to a data URL and imported. Throws with esbuild's own
 * message when the modules do not build, which is a real failure and not a missing file.
 */
export async function loadHivra(build = require("esbuild").build) {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: root, sourcefile: "memory-eval-entry.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    target: "node22",
    logLevel: "silent",
    loader: { ".json": "json" },
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error("esbuild returned no bundle for the memory modules.");
  const module = await import(`data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`);
  for (const name of ["recallDecision", "contentWords", "queryTerms", "memoryId"]) {
    if (typeof module[name] !== "function") throw new Error(`The memory modules have no ${name} export.`);
  }
  return {
    recallDecision: module.recallDecision,
    contentWords: module.contentWords,
    queryTerms: module.queryTerms,
    memoryId: module.memoryId,
    RECALL_MAX_LINES: module.RECALL_MAX_LINES,
    RECALL_MIN_SCORE: module.RECALL_MIN_SCORE,
  };
}
