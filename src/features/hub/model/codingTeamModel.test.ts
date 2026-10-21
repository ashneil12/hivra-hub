// @vitest-environment happy-dom
// E7 (Ash, 21 Oct 20:40): the coding team starts on DeepSeek, High, when a DeepSeek key is set up; otherwise the usual
// default, and the project's options say so. A project's own default still wins; other folders are untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./codingTeam", () => ({ codingTeamsOn: () => true }));
vi.mock("./hubData", () => ({
  hubData: () => ({ listProjects: () => [{ id: "hivra", name: "Hivra", folder: "/Users/ash/harness/hivra" }, { id: "ash", name: "Ash", folder: "/Users/ash" }] }),
}));

import { newDefaultSession, newSessionForProject } from "../../sessions/model/session";
import { setFolderDefaultChoice } from "../../sessions/model/models";
import { setProjectDefaultProvider } from "../../sessions/model/projectProviders";
import { customModelRoute } from "../../sessions/model/customModels";
import { codingTeamModelLine, installCodingTeamDefault } from "./codingTeamModel";

const HIVRA = "/Users/ash/harness/hivra";
const deepseek = { id: "ds1", name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" };

beforeEach(() => {
  localStorage.clear();
  installCodingTeamDefault();
});
afterEach(() => setFolderDefaultChoice(undefined));

describe("the coding team's default model", () => {
  it("with DeepSeek set up, a new coding-team chat starts on DeepSeek at High, and its route sends high", () => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([deepseek]));
    localStorage.setItem("monocode.lastModelSettings", JSON.stringify({ effort: "low" }));
    for (const chat of [newDefaultSession(HIVRA), newSessionForProject(undefined, HIVRA)]) {
      expect(chat).toMatchObject({ harness: "claude", model: "custom:ds1" });
      expect(chat.modelSettings.effort).toBe("high");
      expect(customModelRoute(chat)).toMatchObject({ provider: "deepseek", modelId: "deepseek-chat", reasoningEffort: "high" });
    }
    expect(codingTeamModelLine("Hivra")).toBe("New Hivra coding-team chats start on DeepSeek, High.");
  });

  it("without a DeepSeek key, keeps the usual default and says why", () => {
    const chat = newDefaultSession(HIVRA);
    expect(chat.model.startsWith("custom:")).toBe(false);
    expect(codingTeamModelLine("Hivra")).toBe(
      "New Hivra coding-team chats use your usual default model: DeepSeek isn't set up yet. Add DeepSeek under Other models and they start on DeepSeek, High.",
    );
  });

  it("leaves other folders and Ash's global memory alone, and a project's own default wins", () => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([deepseek]));
    expect(newDefaultSession("/Users/ash/elsewhere").model.startsWith("custom:")).toBe(false);
    expect(newDefaultSession("/Users/ash").model.startsWith("custom:")).toBe(false);
    setProjectDefaultProvider(HIVRA, "claude", "claude:opus");
    expect(newDefaultSession(HIVRA).model).not.toBe("custom:ds1");
  });
});
