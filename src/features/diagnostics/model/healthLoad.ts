// WP-104: the app's own ports for the health list. CLI presence is the launch probe. Sign-in is the identity
// already cached on disk for Claude and Codex. Nothing here starts a second detector or a model.

import { invoke } from "@tauri-apps/api/core";
import {
  hasProbedHarnessAvailability,
  isHarnessAvailable,
  probeHarnessAvailability,
} from "../../../integrations/harness/core/availability";
import { isLiveHarness } from "../../../integrations/harness/core/registry";
import { DEFAULT_PROVIDER_ACCOUNT_ID } from "../../providers/model/providerAccounts";
import { readProviderAccountIdentity } from "../../providers/model/providerAccountIdentity";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { listCustomModels } from "../../sessions/model/customModels";
import { assembleHealth, configuredEndpoint, readCliHealth, type HealthFacts } from "./health";

const SIGN_IN: ReadonlySet<string> = new Set(["claude", "codex"]);

async function appClis() {
  let finished = true;
  try {
    await probeHarnessAvailability();
  } catch {
    finished = hasProbedHarnessAvailability();
  }
  const live = HARNESSES.filter((id) => isLiveHarness(id)).map((id) => ({
    id,
    name: HARNESS_TITLE[id],
  }));
  return readCliHealth(live, {
    installed: (id) => (finished ? isHarnessAvailable(id as HarnessId) : null),
    identity: (id) => {
      if (!SIGN_IN.has(id)) return Promise.resolve(null);
      return readProviderAccountIdentity(id as "claude" | "codex", DEFAULT_PROVIDER_ACCOUNT_ID);
    },
  });
}

export function loadHealthFacts(): Promise<HealthFacts> {
  return assembleHealth({
    now: () => Date.now(),
    endpoint: () => configuredEndpoint(listCustomModels()),
    clis: appClis,
    machine: (gatewayUrl) => invoke("health_facts", { gatewayUrl }),
  });
}
