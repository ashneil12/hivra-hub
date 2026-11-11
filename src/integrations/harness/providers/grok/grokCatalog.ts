import { homeDir } from "../../../../platform/tauri/fs";
import {
  setHarnessModels,
  type AgentModel,
} from "../../../../features/sessions/model/models";
import { AcpClient } from "../../core/acp";
import {
  execChild,
  killChild,
  resolveGrokBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import {
  fallbackGrokModels,
  grokAuthMethodId,
  grokSpawnArgs,
  modelsFromGrokModelsOutput,
  modelsFromInitialize,
  modelsFromSessionNew,
} from "./grokProtocol";

const PROBE_ID = "monocode-grok-probe";
const DISCOVERY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

let inflight: Promise<void> | null = null;

export function refreshGrokCatalog(): Promise<void> {
  if (inflight) return inflight;
  inflight = discoverGrokCatalog()
    .then(({ models, listed }) => {
      // The built-in list fills the picker when Grok will not list its models,
      // but it is not recorded as live.
      if (models.length > 0) setHarnessModels("grok", models, { live: listed });
    })
    .catch((error: unknown) => {
      console.debug("[monocode] grok catalog", error);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function discoverGrokModels(workingDirectory?: string) {
  return (await discoverGrokCatalog(workingDirectory)).models;
}

/** `listed` is true only when Grok itself gave the models, not the built-in list. */
async function discoverGrokCatalog(
  workingDirectory?: string,
): Promise<{ models: AgentModel[]; listed: boolean }> {
  const fromAcp = await discoverViaAcp(workingDirectory).catch((error: unknown) => {
    console.debug("[monocode] grok ACP catalog failed", error);
    return [];
  });
  if (fromAcp.length > 0) return { models: fromAcp, listed: true };
  const fromCli = await discoverViaCli(workingDirectory).catch((error: unknown) => {
    console.debug("[monocode] grok CLI catalog failed", error);
    return [];
  });
  if (fromCli.length > 0) return { models: fromCli, listed: true };
  return { models: fallbackGrokModels(), listed: false };
}

async function discoverViaAcp(workingDirectory?: string) {
  const { path } = await resolveGrokBinary();
  const cwd = workingDirectory ?? (await homeDir());
  const probeId = `${PROBE_ID}-${crypto.randomUUID()}`;
  const acp = new AcpClient(probeId, {
    onRequest: (id) => {
      void acp.respond(id, {}).catch(() => undefined);
    },
  });

  const stop = async () => {
    acp.close();
    unwatchChild(probeId);
    await killChild(probeId).catch(() => undefined);
  };

  watchChild(
    probeId,
    (line) => acp.pushLine(line),
    () => acp.close(new Error("Grok Build probe exited")),
  );

  try {
    await spawnChild(
      probeId,
      path,
      grokSpawnArgs({ model: "" }),
      cwd,
      undefined,
      "grok",
    );
    return await withTimeout(DISCOVERY_TIMEOUT_MS, async () => {
      const init = await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "monocode", version: "0.1.0" },
        },
        REQUEST_TIMEOUT_MS,
      );
      const fromInit = modelsFromInitialize(init);
      if (fromInit.length > 0) return fromInit;

      const methodId = grokAuthMethodId(init);
      if (methodId) {
        await acp
          .request(
            "authenticate",
            { methodId, _meta: { headless: true } },
            REQUEST_TIMEOUT_MS,
          )
          .catch(() => undefined);
      }
      const created = await acp.request(
        "session/new",
        { cwd, mcpServers: [] },
        REQUEST_TIMEOUT_MS,
      );
      return modelsFromSessionNew(created);
    }, () => {
      void stop();
    });
  } finally {
    await stop();
  }
}

async function discoverViaCli(workingDirectory?: string) {
  const { path } = await resolveGrokBinary();
  const cwd = workingDirectory ?? (await homeDir());
  const stdout = await execChild(path, ["models"], cwd, "grok");
  return modelsFromGrokModelsOutput(stdout);
}

function withTimeout<T>(
  ms: number,
  run: () => Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("Grok Build catalog probe timed out"));
    }, ms);
    run()
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
