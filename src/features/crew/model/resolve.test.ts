import { describe, expect, it } from "vitest";
import { defaultCli, defaultLine, resolveRoute, roleModel, type Presence } from "./resolve";
import type { CrewRule } from "./rules";

const signed = (...clis: string[]): Presence[] => clis.map((cli) => ({ cli, installed: true, signedIn: true }));

const ui: CrewRule = { labels: ["ui"], paths: ["src/app"], cli: "cursor", model: "composer", effort: "high", source: "person" };
const plugin: CrewRule = { labels: ["docs"], paths: [], cli: "pi", model: "pi-model", effort: "medium", source: "plugin" };

describe("precedence", () => {
  const rules = [ui, plugin];

  it("uses the override, then the brief, then the first matching rule, one field at a time", () => {
    const route = resolveRoute(
      {
        labels: ["ui"],
        paths: ["src/app/main.tsx"],
        override: { effort: "low" },
        brief: { model: "brief-model" },
      },
      rules,
      signed("codex"),
    );
    expect(route).toMatchObject({
      cli: "cursor",
      cliFrom: "rule",
      model: "brief-model",
      modelFrom: "brief",
      effort: "low",
      effortFrom: "override",
      ruleIndex: 0,
    });
  });

  it("an override CLI wins over the brief and the rule", () => {
    const route = resolveRoute(
      { labels: ["ui"], paths: [], override: { cli: "codex" }, brief: { cli: "pi" } },
      rules,
      signed("claude"),
    );
    expect(route.cli).toBe("codex");
    expect(route.cliFrom).toBe("override");
  });

  it("skips an unknown override and falls through", () => {
    const route = resolveRoute(
      { labels: ["ui"], paths: ["src/app"], override: { cli: "nope", effort: "huge" } },
      rules,
      signed("claude"),
    );
    expect(route.cli).toBe("cursor");
    expect(route.effort).toBe("high");
  });

  it("a person rule beats a plugin rule for the same label", () => {
    const route = resolveRoute({ labels: ["docs"], paths: [] }, [plugin, ui], signed("claude"));
    expect(route.cli).toBe("pi");
    const personFirst = resolveRoute(
      { labels: ["docs"], paths: [] },
      [{ ...plugin, source: "person", cli: "hermes" }, plugin],
      signed("claude"),
    );
    expect(personFirst.cli).toBe("hermes");
  });

  it("no matching rule uses the default, and an empty task matches no rule", () => {
    expect(resolveRoute({ labels: [], paths: [] }, rules, signed("codex", "claude")).cliFrom).toBe("default");
    expect(resolveRoute({ labels: ["review"], paths: ["README.md"] }, rules, signed("codex")).cli).toBe("codex");
  });
});

describe("defaults from signed-in CLIs", () => {
  it("prefers Claude Code when it is installed and signed in", () => {
    expect(defaultCli(signed("codex", "claude"))).toBe("claude");
    expect(defaultLine(signed("codex", "claude"))).toBe("With nothing else set, work uses Claude Code.");
  });

  it("otherwise uses the first signed-in CLI, and ignores one that is only installed", () => {
    expect(defaultCli([{ cli: "claude", installed: true, signedIn: false }, ...signed("cursor", "codex")])).toBe("cursor");
    expect(defaultCli([{ cli: "nope", installed: true, signedIn: true }, ...signed("fx")])).toBe("fx");
    expect(defaultCli([])).toBeNull();
    expect(defaultLine([])).toBe("With nothing else set, work waits until a CLI is installed and signed in.");
  });
});

describe("role models", () => {
  it("uses a cheap model for planning and verdicts, and the rule's model for the work", () => {
    const route = resolveRoute({ labels: ["ui"], paths: ["src/app/main.tsx"] }, [ui], signed("claude"));
    expect(roleModel("work", route)).toEqual({ model: "composer", effort: "high" });
    const claude = resolveRoute({ labels: [], paths: [], override: { cli: "claude", model: "opus", effort: "max" } }, [], signed("claude"));
    expect(roleModel("plan", claude)).toEqual({ model: "claude-haiku-4-5", effort: "low" });
    expect(roleModel("verdict", claude)).toEqual({ model: "claude-haiku-4-5", effort: "low" });
    const fx = resolveRoute({ labels: [], paths: [], override: { cli: "fx", model: "big" } }, [], signed("fx"));
    expect(roleModel("plan", fx).model).toBe("zai/glm-5.2-fast");
    const codex = resolveRoute({ labels: [], paths: [], override: { cli: "codex", model: "gpt" } }, [], signed("codex"));
    expect(roleModel("plan", codex)).toEqual({ model: null, effort: "low" });
  });
});
