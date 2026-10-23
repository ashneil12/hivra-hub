// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { newSession } from "../../sessions/model/session";
import {
  MonoFileConflict,
  type AgentFilePath,
} from "../../monos/model/monoFiles";
import {
  findBotChange,
  setBotFiles,
  undoBotChange,
} from "../../hub/model/botChanges";
import { handleAgentApp, type AgentAppHost } from "./agentApp";

/**
 * `own`: the Mono's own chat. `worker`: a chat that Mono started, which works as the Mono (A7). `none`: a chat no Mono
 * owns, which owns no skills.
 */
function fixture(kind: "own" | "worker" | "none" = "own") {
  const source = newSession("codex", "/tmp/project", "codex:test");
  source.id = kind === "worker" ? "worker-1" : "chat-1";
  const files = new Map<string, string>([
    ["skills/deploy.md", "# Deploy\n\n- Run the checks.\n"],
  ]);
  const versions = new Map<string, number>();
  const hash = (path: string) => `${path}@${versions.get(path) ?? 0}`;
  const write = vi.fn(
    async (
      _monoId: string,
      path: AgentFilePath,
      text: string,
      expected: string,
    ) => {
      if (expected !== hash(path)) throw new MonoFileConflict();
      files.set(path, text);
      versions.set(path, (versions.get(path) ?? 0) + 1);
      return hash(path);
    },
  );
  const host = {
    isMono: (id: string) => kind === "own" && id === source.id,
    monoOf: (id: string) =>
      kind === "own" && id === source.id
        ? { id: "mono-1", projects: [] }
        : undefined,
    ownerMonoOf: (id: string) =>
      kind === "worker" && id === source.id ? "mono-1" : undefined,
    monoNameOf: () => "Hivra lead",
    readAgentFile: async (_monoId: string, path: AgentFilePath) => ({
      text: files.get(path) ?? null,
      hash: hash(path),
    }),
    writeAgentFile: write,
    agentFiles: async () => ({
      id: "mono-1",
      dir: "/data/monos/mono-1",
      soul: "",
      soulHash: "",
      memory: "",
      memoryHash: "",
      memoryPath: "/data/monos/mono-1/MEMORY.md",
      topics: [],
      skills: [...files.keys()]
        .filter((path) => path.startsWith("skills/"))
        .map((path) => path.slice("skills/".length, -".md".length)),
    }),
  } as unknown as AgentAppHost;
  const run = (action: string, input: Record<string, unknown> = {}) =>
    handleAgentApp(source, `req-${Math.random()}`, action, input, host);
  const botFiles = {
    read: async (_monoId: string, path: AgentFilePath) => ({
      text: files.get(path) ?? null,
      hash: hash(path),
    }),
    write: (monoId: string, path: AgentFilePath, text: string, expected: string) =>
      write(monoId, path, text, expected),
  };
  return { files, write, botFiles, run };
}

it("lists, reads and improves the skills of its own Mono (A7)", async () => {
  const { files, run } = fixture();
  expect(await run("skills.list")).toEqual({ skills: ["deploy"] });
  expect(await run("skills.read", { name: "deploy" })).toEqual({
    file: "skills/deploy.md",
    text: "# Deploy\n\n- Run the checks.\n",
    exists: true,
    hash: "skills/deploy.md@0",
  });
  expect(await run("skills.read", { name: "missing" })).toMatchObject({
    text: "",
    exists: false,
  });

  const added = "# Release\n\n- Tag first.\n";
  expect(
    await run("skills.write", {
      name: "release",
      text: added,
      expectedHash: "skills/release.md@0",
    }),
  ).toEqual({
    file: "skills/release.md",
    updated: true,
    hash: "skills/release.md@1",
  });
  expect(files.get("skills/release.md")).toBe(added);
  // A name given with its extension is the same skill.
  expect(await run("skills.read", { name: "release.md" })).toMatchObject({
    exists: true,
    text: added,
  });
});

it("records a new skill and a changed one as Bot changes rows (D1)", async () => {
  const { run } = fixture();
  await run("skills.write", {
    name: "release",
    text: "# Release\n\n- Tag first.\n",
    expectedHash: "skills/release.md@0",
  });
  expect(findBotChange("self-write:mono-1:skills/release.md:chat-1")).toMatchObject({
    bot: "Hivra lead",
    line: "Hivra lead wrote a new skill, “release”",
    monoId: "mono-1",
    file: "skills/release.md",
    beforeText: "",
    afterText: "# Release\n\n- Tag first.\n",
  });

  const improved = "# Deploy\n\n- Run the checks.\n- Then ship.\n";
  await run("skills.write", {
    name: "deploy",
    text: improved,
    expectedHash: "skills/deploy.md@0",
  });
  expect(findBotChange("self-write:mono-1:skills/deploy.md:chat-1")).toMatchObject({
    line: "Hivra lead changed the “deploy” skill",
    beforeText: "# Deploy\n\n- Run the checks.\n",
    afterText: improved,
  });
});

it("lets a worker improve the skills of the Mono it works as (A7)", async () => {
  const { files, run } = fixture("worker");
  expect(await run("skills.read", { name: "deploy" })).toMatchObject({
    exists: true,
  });
  const improved = "# Deploy\n\n- Run the checks.\n- Wait for CI.\n";
  await run("skills.write", {
    name: "deploy",
    text: improved,
    expectedHash: "skills/deploy.md@0",
  });
  expect(files.get("skills/deploy.md")).toBe(improved);
  // The Mono's name stands on the row: the worker writes as the Mono.
  expect(
    findBotChange("self-write:mono-1:skills/deploy.md:worker-1"),
  ).toMatchObject({
    bot: "Hivra lead",
    line: "Hivra lead changed the “deploy” skill",
  });
});

it("refuses skills to a chat no Mono owns", async () => {
  const { run, write } = fixture("none");
  const refused = "A skill belongs to a Mono. This chat isn't one, and no Mono started it.";
  await expect(run("skills.list")).rejects.toThrow(refused);
  await expect(run("skills.read", { name: "deploy" })).rejects.toThrow(refused);
  await expect(
    run("skills.write", {
      name: "deploy",
      text: "# Deploy\n",
      expectedHash: "skills/deploy.md@0",
    }),
  ).rejects.toThrow(refused);
  expect(write).not.toHaveBeenCalled();
});

it("keeps a skill name inside the Mono's own folder", async () => {
  const { run, write } = fixture();
  for (const name of [".hidden", "a/b", "", 7]) {
    await expect(
      run("skills.write", { name, text: "# x\n", expectedHash: "h" }),
    ).rejects.toThrow(/name/);
  }
  expect(write).not.toHaveBeenCalled();
});

it("asks for a reread when the skill changed since it was read", async () => {
  const { run, write } = fixture();
  await expect(
    run("skills.write", {
      name: "deploy",
      text: "# Deploy\n",
      expectedHash: "skills/deploy.md@9",
    }),
  ).rejects.toThrow(
    "skills/deploy.md changed since you read it. Run skills.read and reapply your improvements to the current text before writing again.",
  );
  expect(write).toHaveBeenCalledTimes(1);
});

it("Undo puts a skill back to how it was before the write (D1)", async () => {
  const { files, botFiles, run } = fixture();
  const before = files.get("skills/deploy.md")!;
  await run("skills.write", {
    name: "deploy",
    text: "# Deploy\n\n- Run the checks.\n- Then ship.\n",
    expectedHash: "skills/deploy.md@0",
  });
  const id = "self-write:mono-1:skills/deploy.md:chat-1";
  expect(findBotChange(id)).toBeDefined();
  setBotFiles(botFiles);
  await undoBotChange([id]);
  expect(files.get("skills/deploy.md")).toBe(before);
});
