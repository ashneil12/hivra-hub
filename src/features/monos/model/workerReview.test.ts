import { describe, expect, it } from "vitest";
import {
  nothingOpen,
  parseWorkerReview,
  reviewAsk,
  withEarlierReport,
  REVIEW_FIELD_MAX,
  SELF_REVIEW_SHAPE,
  storedReview,
} from "./workerReview";

const report = (review: string) => `Fixed the login and added a test.\n\n${review}`;

const GOOD = `## Self-review
Checked: the login flow and the new test
How: npx vitest run src/features/auth/login.test.ts
Unsure: nothing`;

describe("parseWorkerReview", () => {
  it("reads the three lines a worker wrote", () => {
    expect(parseWorkerReview(report(GOOD))).toEqual({
      kind: "ok",
      review: {
        checked: "the login flow and the new test",
        how: "npx vitest run src/features/auth/login.test.ts",
        unsure: "nothing",
      },
    });
  });

  it("accepts bold markers, bullets and a heading with a colon", () => {
    const reply = report(`## Self Review:

- **Checked:** the migration
- **How:** ran it against a copy of the database
- **Unsure:** whether old rows keep their timestamps`);
    const ruling = parseWorkerReview(reply);
    expect(ruling.kind).toBe("ok");
    if (ruling.kind !== "ok") return;
    expect(ruling.review.checked).toBe("the migration");
    expect(ruling.review.unsure).toBe("whether old rows keep their timestamps");
  });

  it("keeps a value that runs onto the next line", () => {
    const ruling = parseWorkerReview(
      report(`## Self-review\nChecked: both routes\nand the redirect\nHow: clicked through in the dev copy\nUnsure: nothing`),
    );
    expect(ruling.kind).toBe("ok");
    if (ruling.kind === "ok") expect(ruling.review.checked).toBe("both routes and the redirect");
  });

  it("reads the last self-review, not one quoted earlier in the report", () => {
    const reply = report(
      `The brief asked for:\n\n## Self-review\nChecked: x\nHow: y\nUnsure: z\n\n${GOOD}`,
    );
    const ruling = parseWorkerReview(reply);
    expect(ruling.kind).toBe("ok");
    if (ruling.kind === "ok") expect(ruling.review.checked).toBe("the login flow and the new test");
  });

  it("stops at the next heading, so a later section is not read as review text", () => {
    const ruling = parseWorkerReview(
      report(`## Self-review\nChecked: the API\nHow: curl\nUnsure: nothing\n\n## Files changed\n- src/api.ts`),
    );
    expect(ruling.kind).toBe("ok");
    if (ruling.kind === "ok") expect(ruling.review.unsure).toBe("nothing");
  });

  it("refuses a report with no self-review", () => {
    const ruling = parseWorkerReview("Fixed it. All tests pass.");
    expect(ruling.kind).toBe("refused");
    if (ruling.kind === "refused") expect(ruling.reason).toMatch(/no "## Self-review" section/);
  });

  it("refuses a review missing a line, naming the line the worker has to add", () => {
    const ruling = parseWorkerReview(report(`## Self-review\nChecked: the login\nUnsure: nothing`));
    expect(ruling.kind).toBe("refused");
    if (ruling.kind === "refused") expect(ruling.reason).toMatch(/"How:" line/);
  });

  it("refuses an empty line rather than reading it as nothing to report", () => {
    const ruling = parseWorkerReview(report(`## Self-review\nChecked:\nHow: read the diff\nUnsure: nothing`));
    expect(ruling.kind).toBe("refused");
    if (ruling.kind === "refused") expect(ruling.reason).toMatch(/"Checked:" line is empty/);
  });

  it("refuses an empty Unsure line: it has to say what is open or say nothing", () => {
    const ruling = parseWorkerReview(report(`## Self-review\nChecked: the login\nHow: ran it\nUnsure:`));
    expect(ruling.kind).toBe("refused");
    if (ruling.kind === "refused") expect(ruling.reason).toMatch(/or "nothing"/);
  });

  it("refuses a review that is a second report", () => {
    const ruling = parseWorkerReview(report(`## Self-review\nChecked: ${"a ".repeat(REVIEW_FIELD_MAX)}\nHow: x\nUnsure: nothing`));
    expect(ruling.kind).toBe("refused");
    if (ruling.kind === "refused") expect(ruling.reason).toMatch(/longer than/);
  });

  it("refuses a report that only has the template headings, with no answer", () => {
    expect(parseWorkerReview(report(SELF_REVIEW_SHAPE)).kind).toBe("refused");
  });
});

describe("reviewAsk", () => {
  it("gives the reason, the shape and tells the worker not to start over", () => {
    const ask = reviewAsk('The self-review has no "How:" line.');
    expect(ask).toContain('The self-review has no "How:" line.');
    expect(ask).toContain("## Self-review");
    expect(ask).toContain("Checked:");
    expect(ask).toContain("Unsure:");
    expect(ask).toMatch(/Don't redo the work/);
    // r82: the report is kept, so the reply is the section alone and the chat never shows the report twice.
    expect(ask).toMatch(/don't send the report again/);
    expect(ask).toMatch(/Reply with only this section/);
    expect(ask).not.toMatch(/Send your report again/);
  });
});

describe("storedReview", () => {
  it("reads back what the row stored", () => {
    const review = { checked: "a", how: "b", unsure: "nothing" };
    expect(storedReview(JSON.stringify(review))).toEqual(review);
  });

  it("ignores a value of the wrong shape or no value at all", () => {
    expect(storedReview(null)).toBeUndefined();
    expect(storedReview("not json")).toBeUndefined();
    expect(storedReview('{"checked":"a"}')).toBeUndefined();
  });
});

it("tells an explicit nothing apart from an open question", () => {
  expect(nothingOpen("nothing")).toBe(true);
  expect(nothingOpen("None.")).toBe(true);
  expect(nothingOpen("whether the cache is stale")).toBe(false);
});

describe("withEarlierReport (r82: one report, not two)", () => {
  const first = "Added delete for tallies: the board drops them, and the API returns 404 after.\nTests: 41 pass.";
  const section = "## Self-review\nChecked: delete and the board\nHow: npm test\nUnsure: nothing";

  it("joins the first report and the self-review sent back, once", () => {
    const joined = withEarlierReport(first, section);
    expect(joined).toBe(`${first}\n\n${section}`);
    expect(joined.split("Added delete for tallies").length - 1).toBe(1);
    expect(parseWorkerReview(joined).kind).toBe("ok");
  });

  it("keeps a reply that repeated its whole report as it came, not doubled", () => {
    const repeated = `${first}\n\n${section}`;
    expect(withEarlierReport(first, repeated)).toBe(repeated);
  });

  it("drops a broken self-review the first report ended with", () => {
    const broken = `${first}\n\n## Self-review\nChecked: delete`;
    const joined = withEarlierReport(broken, section);
    expect(joined).toBe(`${first}\n\n${section}`);
    expect(joined.match(/## Self-review/g)).toHaveLength(1);
  });
});
