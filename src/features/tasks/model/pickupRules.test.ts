import { describe, expect, it } from "vitest";
import type { Mono } from "../../monos/model/mono";
import { describeRule, firstMatesFor, readPickupRules, splitNames } from "./pickupRules";

describe("pickup rules (WP-250)", () => {
  it("reads the store's rows and drops ones without an owner", () => {
    expect(
      readPickupRules([
        { ownerSession: "mate-1", project: "app", statuses: ["Todo"], labels: [], enabled: true, createdAt: 3 },
        { project: "app" },
        "junk",
      ]),
    ).toEqual([{ ownerSession: "mate-1", project: "app", statuses: ["Todo"], labels: [], enabled: true, createdAt: 3 }]);
    expect(readPickupRules(null)).toEqual([]);
  });

  it("splits a typed list and drops blanks and repeats", () => {
    expect(splitNames(" Todo, in review,, todo ,In review ")).toEqual(["Todo", "in review"]);
  });

  it("says what the first mate takes in plain words", () => {
    expect(describeRule({ project: "app", statuses: ["Todo", "Backlog"], labels: ["bug"], enabled: true })).toBe(
      "Takes unassigned tasks in app with status Todo or Backlog, labelled bug",
    );
    expect(describeRule({ project: "app", statuses: ["Todo"], labels: [], enabled: true }, "app")).toBe(
      "Takes unassigned tasks in this project with status Todo",
    );
    expect(describeRule({ project: null, statuses: [], labels: ["ui"], enabled: false })).toBe(
      "Takes unassigned tasks in any project with any status, labelled ui (off)",
    );
  });

  it("offers only the first mates that work on this project, by the chat they work it in", () => {
    const mono = (id: string, extra: Partial<Mono>): Mono => ({ id, mascot: "cat", color: "blue", projects: [], ...extra });
    const monos = [
      mono("scout", { name: "Scout", sessionId: "s-1", projects: ["/work/app/"] }),
      mono("cos", { name: "Chief", sessionId: "s-home", projectSessions: { app: "s-app" }, projects: ["hub-project:app"] }),
      mono("checker", { sessionId: "s-check", projects: ["/work/app"] }),
      mono("away", { sessionId: "s-9", projects: ["/work/other"] }),
      mono("new", { projects: ["/work/app"] }),
    ];
    expect(firstMatesFor(monos, "app", "/work/app", (m) => m.name ?? m.id)).toEqual([
      { session: "s-1", name: "Scout" },
      { session: "s-app", name: "Chief" },
    ]);
  });
});
