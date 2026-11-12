import { describe, expect, it } from "vitest";
import { createAutomationTrigger, type Automation } from "./automations";
import { mapLayout } from "./mapLayout";

function automation(
  partial: Partial<Automation> & Pick<Automation, "id" | "name">,
): Automation {
  return {
    id: partial.id,
    name: partial.name,
    prompt: "PROMPT_SHOULD_NOT_LEAK",
    harness: "codex",
    model: "model",
    cwd: partial.cwd ?? "/work/project",
    workspaceMode: partial.workspaceMode ?? "current",
    worktreeCwd: partial.worktreeCwd,
    reuseSession: partial.reuseSession ?? false,
    runtimeMode: "auto",
    triggerKind: partial.triggerKind ?? "time",
    triggerEvent: partial.triggerEvent ?? "",
    scheduleKind: partial.scheduleKind ?? "weekdays",
    minute: partial.minute ?? 0,
    time: partial.time ?? "09:00",
    dayOfWeek: partial.dayOfWeek ?? 1,
    triggers: partial.triggers,
    missedRunGraceMinutes: 720,
    enabled: partial.enabled ?? true,
    nextRunAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

const nine = () =>
  createAutomationTrigger("time", "weekdays", {
    id: "time-a",
    time: "09:00",
    scheduleKind: "weekdays",
  });

const issue = (id: string) =>
  createAutomationTrigger("github", "issue_opened", {
    id,
    repo: "owner/repo",
  });

describe("mapLayout", () => {
  it("puts two triggers on one automation, then where the work goes", () => {
    const layout = mapLayout([
      automation({
        id: "morning",
        name: "Morning audit",
        triggers: [nine(), issue("issue-a")],
        workspaceMode: "worktree",
        reuseSession: true,
        cwd: "C:\\work\\project",
      }),
    ]);
    const triggers = layout.nodes.filter((node) => node.kind === "trigger");
    const autos = layout.nodes.filter((node) => node.kind === "automation");
    const destinations = layout.nodes.filter((node) => node.kind === "destination");
    expect(triggers.map((node) => node.label).sort()).toEqual([
      "A new issue in owner/repo",
      "The 9:00 schedule",
    ]);
    expect(autos).toHaveLength(1);
    expect(autos[0]?.label).toBe("Morning audit");
    expect(layout.edges.filter((edge) => edge.to === "automation:morning")).toHaveLength(2);
    expect(destinations.map((node) => node.label).sort()).toEqual([
      "A fresh worktree",
      "The last chat",
      "project",
    ]);
    expect(triggers.every((node) => node.x < (autos[0]?.x ?? 0))).toBe(true);
    expect(destinations.every((node) => node.x > (autos[0]?.x ?? 0))).toBe(true);
    expect(JSON.stringify(layout)).not.toContain("PROMPT_SHOULD_NOT_LEAK");
    expect(layout.emptyMessage).toBeNull();
  });

  it("shares one trigger node across two automations", () => {
    const layout = mapLayout([
      automation({
        id: "a",
        name: "Alpha",
        triggers: [nine(), issue("issue-a")],
      }),
      automation({
        id: "b",
        name: "Beta",
        triggers: [
          createAutomationTrigger("github", "issue_opened", {
            id: "issue-b",
            repo: "owner/repo",
          }),
        ],
      }),
    ]);
    const issueNodes = layout.nodes.filter(
      (node) => node.label === "A new issue in owner/repo",
    );
    expect(issueNodes).toHaveLength(1);
    const fromIssue = layout.edges.filter((edge) => edge.from === issueNodes[0]?.id);
    expect(fromIssue.map((edge) => edge.to).sort()).toEqual([
      "automation:a",
      "automation:b",
    ]);
    expect(issueNodes[0]?.automationId).toBe("");
  });

  it("fades a disabled automation and keeps it on the map", () => {
    const layout = mapLayout([
      automation({ id: "off", name: "Paused", enabled: false, triggers: [nine()] }),
    ]);
    const node = layout.nodes.find((item) => item.kind === "automation");
    expect(node?.disabled).toBe(true);
    expect(node?.automationId).toBe("off");
    expect(layout.nodes.some((item) => item.kind === "trigger" && !item.disabled)).toBe(
      true,
    );
  });

  it("says there are no automations yet", () => {
    const layout = mapLayout([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.emptyMessage).toBe("No automations yet");
  });

  it("keeps the first of a duplicate id and drops a blank id", () => {
    const layout = mapLayout([
      automation({ id: "same", name: "First" }),
      automation({ id: "same", name: "Second" }),
      automation({ id: "  ", name: "Missing" }),
    ]);
    const autos = layout.nodes.filter((node) => node.kind === "automation");
    expect(autos.map((node) => node.label)).toEqual(["First"]);
  });

  it("labels a windows path by its last folder and stacks a column top to bottom", () => {
    const layout = mapLayout([
      automation({
        id: "win",
        name: "Windows",
        cwd: "C:\\Users\\me\\My Projects\\",
        triggers: [nine(), issue("issue-a")],
      }),
    ]);
    expect(layout.nodes.some((node) => node.label === "My Projects")).toBe(true);
    const triggers = layout.nodes.filter((node) => node.kind === "trigger");
    expect(triggers[0]?.y).toBeLessThan(triggers[1]?.y ?? 0);
    expect(triggers[0]?.label.localeCompare(triggers[1]?.label ?? "")).toBeLessThan(0);
  });

  it("draws one trigger node for each repo, not only the first", () => {
    const layout = mapLayout([
      automation({
        id: "both",
        name: "Both",
        triggers: [
          createAutomationTrigger("github", "issue_opened", {
            id: "issues",
            repos: ["acme/web", "acme/api"],
          }),
        ],
      }),
    ]);
    const triggers = layout.nodes.filter((node) => node.kind === "trigger");
    expect(triggers.map((node) => node.label).sort()).toEqual([
      "A new issue in acme/api",
      "A new issue in acme/web",
    ]);
    expect(layout.edges.filter((edge) => edge.to === "automation:both")).toHaveLength(2);
  });

  it("scrubs a token in a name or a repo before it is drawn", () => {
    const token = `ghp_${"A".repeat(30)}`;
    const key = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
    const layout = mapLayout([
      automation({
        id: "leaky",
        name: `Audit ${key}`,
        triggers: [
          createAutomationTrigger("github", "issue_opened", {
            id: "issues",
            repo: `https://git:${token}@github.com/acme/web`,
          }),
        ],
      }),
    ]);
    const dumped = JSON.stringify(layout);
    expect(dumped).toContain("[secret removed]");
    expect(dumped).not.toContain("ghp_");
    expect(dumped).not.toContain("sk-ant-");
    expect(dumped).not.toContain("PROMPT_SHOULD_NOT_LEAK");
  });

  it("labels each trigger node by its schedule or event", () => {
    const labels = (rows: Automation[]) =>
      mapLayout(rows)
        .nodes.filter((node) => node.kind === "trigger")
        .map((node) => node.label)
        .sort();
    expect(
      labels([
        automation({
          id: "hour",
          name: "Hourly",
          triggers: [
            createAutomationTrigger("time", "hourly", {
              id: "time-hour",
              scheduleKind: "hourly",
              minute: 15,
            }),
          ],
        }),
      ]),
    ).toEqual(["The hourly schedule"]);
    expect(
      labels([
        automation({
          id: "bad",
          name: "Bad clock",
          triggers: [
            createAutomationTrigger("time", "daily", {
              id: "time-bad",
              scheduleKind: "daily",
              time: "25:00",
            }),
            createAutomationTrigger("time", "daily", {
              id: "time-blank",
              scheduleKind: "daily",
              time: "",
            }),
          ],
        }),
      ]),
    ).toEqual(["The schedule", "The schedule"]);
    expect(
      labels([
        automation({
          id: "bare",
          name: "Bare",
          triggers: [
            createAutomationTrigger("github", "issue_opened", { id: "no-repo" }),
            createAutomationTrigger("github", "not_a_known_event", { id: "unknown" }),
          ],
        }),
      ]),
    ).toEqual(["A new issue", "An event"]);
    expect(
      labels([
        automation({
          id: "repos",
          name: "Repos",
          triggers: [
            createAutomationTrigger("github", "issue_opened", {
              id: "list",
              repo: "  ",
              repos: ["acme/web", " ", "acme/web", "acme/api"],
            }),
          ],
        }),
      ]),
    ).toEqual(["A new issue in acme/api", "A new issue in acme/web"]);
  });
});
