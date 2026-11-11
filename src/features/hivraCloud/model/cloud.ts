import { invoke } from "@tauri-apps/api/core";
import { endpointProblem } from "./endpoint";

export type CloudState = "off" | "no_endpoint" | "bad_endpoint" | "ready";

export type CloudStatus = {
  state: CloudState;
  enabled: boolean;
  endpoint: string;
  revision: number;
  signedIn: boolean;
  message: string | null;
};

export const CLOUD_OFF: CloudStatus = {
  state: "off",
  enabled: false,
  endpoint: "",
  revision: 0,
  signedIn: false,
  message: null,
};

export const ACCOUNT_NOTICE =
  "Hivra Cloud can't be reached right now. Your own machines still work.";

export type AccountView = {
  status: string;
  plan: string | null;
  machineLimit: number | null;
  notice: string | null;
};

export class CloudSaveConflict extends Error {
  constructor() {
    super("Hivra Cloud was changed somewhere else. Nothing was saved.");
    this.name = "CloudSaveConflict";
  }
}

export type CloudApi = {
  status: () => Promise<unknown>;
  save: (enabled: boolean, endpoint: string, revision: number) => Promise<unknown>;
  signIn: () => Promise<unknown>;
  signOut: () => Promise<unknown>;
  account: () => Promise<unknown>;
  pair: (code: string) => Promise<unknown>;
};

function revisionOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : 0;
}

function endpointOf(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 2048) : "";
}

// A missing or dishonest answer stays off. Only a boolean true turns the switch on.
export function asStatus(value: unknown): CloudStatus {
  if (!value || typeof value !== "object") return CLOUD_OFF;
  const row = value as Record<string, unknown>;
  const revision = revisionOf(row.revision);
  if (row.enabled !== true && row.enabled !== false) return CLOUD_OFF;
  const endpoint = endpointOf(row.endpoint);
  if (row.enabled === false) {
    return {
      state: "off",
      enabled: false,
      endpoint,
      revision,
      signedIn: false,
      message: endpoint ? endpointProblem(endpoint) : null,
    };
  }
  if (endpoint === "") {
    return { state: "no_endpoint", enabled: true, endpoint: "", revision, signedIn: false, message: null };
  }
  const problem = endpointProblem(endpoint);
  if (problem) {
    return { state: "bad_endpoint", enabled: true, endpoint, revision, signedIn: false, message: problem };
  }
  return {
    state: "ready",
    enabled: true,
    endpoint,
    revision,
    signedIn: row.signedIn === true,
    message: null,
  };
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  let text = "";
  for (const char of value) {
    const codePoint = char.charCodeAt(0);
    if (codePoint >= 32 && codePoint !== 127) text += char;
  }
  text = text.trim();
  if (!text) return null;
  return text.slice(0, max);
}

export function asAccount(value: unknown): AccountView {
  if (!value || typeof value !== "object") {
    return { status: "unavailable", plan: null, machineLimit: null, notice: null };
  }
  const row = value as Record<string, unknown>;
  const machineLimit =
    typeof row.machineLimit === "number" && Number.isInteger(row.machineLimit) && row.machineLimit >= 0
      ? row.machineLimit
      : null;
  return {
    status: cleanText(row.status, 40) ?? "unavailable",
    plan: cleanText(row.plan, 80),
    machineLimit,
    notice: cleanText(row.notice, 300),
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const cloudApi: CloudApi = {
  status: () => invoke("hivra_cloud_status"),
  async save(enabled, endpoint, revision) {
    try {
      return await invoke("hivra_cloud_save", { enabled, endpoint, expectedRevision: revision });
    } catch (error) {
      if (messageOf(error).includes("changed somewhere else")) throw new CloudSaveConflict();
      throw error instanceof Error ? error : new Error(messageOf(error));
    }
  },
  signIn: () => invoke("hivra_cloud_sign_in"),
  signOut: () => invoke("hivra_cloud_sign_out"),
  account: () => invoke("hivra_cloud_account"),
  pair: (code) => invoke("hivra_cloud_pair", { code }),
};
