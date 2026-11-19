// @vitest-environment happy-dom
// G3: the Chief of Staff's own chat for a project carries that project's brief every turn; its chat on Home does not.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { monoTurn } from "../../monos/model/monoFiles";
import type { NeedsItem } from "../../needs/model/needsYou";
import { setHubDataSource } from "./hubData";
import { mapProject } from "./hubStore";
import { mockHubData } from "./mockData";
import { BRIEF_MAX_NEEDS, projectChatBrief } from "./projectChatBrief";
import type { HubProject } from "./types";

const ALPHA: HubProject = {
  id: "alpha",
  name: "Alpha",
  shortName: "Alpha",
  iconShape: "rocket",
  folder: "/work/alpha",
  oneLine: "A small app that books dog walks",
};
const BETA: HubProject = { id: "beta", name: "Beta", shortName: "Beta", iconShape: "book", folder: "/work/beta", oneLine: "The family recipe book" };

function roster() {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      { id: "chief", name: "Chief of Staff", sessionId: "home-chat", projectSessions: { alpha: "alpha-chat", beta: "beta-chat" }, projects: [] },
      { id: "mina", name: "Mina", role: "Writes the docs", projects: ["/work/alpha"] },
      { id: "jo", name: "Jo", projects: ["/work/beta"] },
    ].map((mono) => ({ mascot: "robot", color: "hsl(0 0% 50%)", ...mono }))),
  );
}

function need(projectId: string, n: number, sentence = `asked question ${n}`): NeedsItem {
  return { key: `${projectId}-${n}`, kind: "question", projectId, who: `Lead ${n}`, at: n, sentence, actions: [] } as NeedsItem;
}

const needs = [need("alpha", 1, "asked which colour the button is"), need("beta", 2, "asked about the soup")];
const readers = { needs: () => needs };

beforeEach(() => {
  localStorage.clear();
  roster();
  setHubDataSource({ ...mockHubData, listProjects: () => [ALPHA, BETA] });
});

afterEach(() => {
  setHubDataSource(undefined);
  localStorage.clear();
});

describe("a project's Chief of Staff chat", () => {
  it("carries that project's brief ahead of the message: name, one line, folder, first mates and open needs", () => {
    const brief = projectChatBrief("alpha-chat", readers);
    expect(brief).toBeDefined();
    const turn = monoTurn("How is it going?", [brief!]);
    expect(turn.indexOf("<project_brief>")).toBeLessThan(turn.indexOf("How is it going?"));
    expect(brief).toContain("Alpha (`alpha`)");
    expect(brief).toContain("A small app that books dog walks");
    expect(brief).toContain("/work/alpha");
    expect(brief).toContain("Mina (Writes the docs)");
    expect(brief).toContain("Lead 1: asked which colour the button is");
    // Only this project: not another project's mates, needs or line, and not the chat's own Mono as a mate.
    expect(brief).not.toContain("Jo");
    expect(brief).not.toContain("soup");
    expect(brief).not.toContain("recipe");
    expect(brief).not.toContain("Chief of Staff");
  });

  it("carries the project of the chat it is, not another one", () => {
    const brief = projectChatBrief("beta-chat", readers)!;
    expect(brief).toContain("Beta (`beta`)");
    expect(brief).toContain("Jo");
    expect(brief).toContain("asked about the soup");
    expect(brief).not.toContain("Alpha");
  });

  it("says so when nothing waits and no first mate works on it", () => {
    localStorage.setItem(
      "monocode:mono-roster",
      JSON.stringify([{ id: "chief", name: "Chief of Staff", sessionId: "home-chat", projectSessions: { alpha: "alpha-chat" }, projects: [], mascot: "robot", color: "hsl(0 0% 50%)" }]),
    );
    const brief = projectChatBrief("alpha-chat", { needs: () => [] })!;
    expect(brief).toContain("No first mate works on it yet.");
    expect(brief).toContain("Nothing for it is waiting on Ash.");
  });
});

describe("the project's one line", () => {
  it("comes from the local store's record of the project", () => {
    const fromStore = mapProject({ id: "alpha", name: "Alpha", shortName: "Alpha", iconShape: "rocket", folder: "/work/alpha", oneLine: "Books dog walks" });
    expect(fromStore?.oneLine).toBe("Books dog walks");
    setHubDataSource({ ...mockHubData, listProjects: () => [fromStore!, BETA] });
    expect(projectChatBrief("alpha-chat", readers)).toContain("What it is: Books dog walks");
  });
});

describe("Home's Chief of Staff chat", () => {
  it("carries no one project's brief", () => {
    expect(projectChatBrief("home-chat", readers)).toBeUndefined();
  });

  it("nor does a chat that isn't a Mono's, or one for a project no longer on the hub", () => {
    expect(projectChatBrief("plain-chat", readers)).toBeUndefined();
    setHubDataSource({ ...mockHubData, listProjects: () => [BETA] });
    expect(projectChatBrief("alpha-chat", readers)).toBeUndefined();
  });
});

describe("the brief stays short", () => {
  it("lists only the first few needs of a project with many and counts the rest", () => {
    const many = Array.from({ length: 30 }, (_, i) => need("alpha", i + 1, `asked question ${i + 1} ${"and more words ".repeat(30)}`));
    const brief = projectChatBrief("alpha-chat", { needs: () => many })!;
    const listed = brief.split("\n").filter((line) => line.startsWith("- Lead "));
    expect(listed).toHaveLength(BRIEF_MAX_NEEDS);
    expect(brief).toContain("(30)");
    expect(brief).toContain(`and ${30 - BRIEF_MAX_NEEDS} more in the Inbox.`);
    for (const line of listed) expect(line.length).toBeLessThanOrEqual(2 + 160);
    expect(brief.length).toBeLessThan(2_000);
  });

  it("never carries a secret a need's words held", () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const brief = projectChatBrief("alpha-chat", { needs: () => [need("alpha", 1, `asked to use token ${token}`)] })!;
    expect(brief).not.toContain(token);
    expect(brief).toContain("Lead 1: asked to use token");
  });
});
