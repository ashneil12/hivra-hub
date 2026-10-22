// Ash's rule (21 Oct): there is no "gave up" state. A stuck job is just "needs you", and the Lead's chat says why.
// Internal ids such as `gave_up` and `lead_gave_up` stay; no string or JSX text the app can show says "gave up".
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { gaveUpReason } from "../../features/monos/model/selfRepair";
import { failureLine } from "../../features/monos/model/workerStuck";
import { TEMPLATES } from "../../features/hub/model/templates";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const GAVE_UP = /gave\s+up/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every piece of text in a file that could reach the screen: string literals, template parts and JSX text (not comments). */
function visibleTexts(file: string): { line: number; text: string }[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('no "gave up" wording Ash can see', () => {
  it("no string or JSX text in the app says gave up", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const { line, text } of visibleTexts(file)) {
        if (GAVE_UP.test(text)) hits.push(`${relative(SRC, file)}:${line}: ${text}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the lines a stuck job shows read as stuck / needs you", () => {
    expect(gaveUpReason({ state: "failed", stallKind: null, errorClass: null, error: "Claude exited with code 1" }, 4)).not.toMatch(GAVE_UP);
    expect(failureLine({ errorClass: null, error: "Claude exited with code 1", state: "failed", log: [] })).not.toMatch(GAVE_UP);
    for (const t of TEMPLATES) for (const card of t.todayCards) expect(card).not.toMatch(GAVE_UP);
  });
});
