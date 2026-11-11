/** Unit-test stand-in for @pierre/diffs. The browser spec loads the real package. */

export function parseDiffFromFile(
  before: { name: string; contents: string },
  after: { name: string; contents: string },
) {
  return { name: before.name, before: before.contents, after: after.contents };
}
