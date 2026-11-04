import { invoke } from "@tauri-apps/api/core";
import {
  isRetiredGrokLauncherPath,
  retireGrokLauncherOnce,
} from "../../sessions/model/grokRetirement";
import type { HarnessId } from "../../sessions/model/session";

export type ConfigurableBinaryProvider = HarnessId;

const STORAGE_KEY = "monocode.providerBinaryPaths.v1";

type StoredBinaryPaths = Partial<Record<ConfigurableBinaryProvider, string>>;

function readProviderBinaryPaths(): StoredBinaryPaths {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).filter(([, path]) => typeof path === "string"),
    ) as StoredBinaryPaths;
  } catch {
    return {};
  }
}

const runtimeBinaryPaths = readProviderBinaryPaths();

export async function initializeProviderBinaryPaths(): Promise<void> {
  // WP-16: drop a stored retired-launcher path before asking Rust, including when that
  // call times out. The in-memory path is cleared too, so this window does not
  // keep launching the retired launcher.
  const retired = retireGrokLauncherOnce(localStorage);
  if (retired.cleared || isRetiredGrokLauncherPath(runtimeBinaryPaths.claude ?? "")) {
    delete runtimeBinaryPaths.claude;
  }
  const active = await invoke<StoredBinaryPaths>("harness_runtime_binary_paths", {
    paths: readProviderBinaryPaths(),
  });
  for (const provider of Object.keys(runtimeBinaryPaths)) {
    delete runtimeBinaryPaths[provider as ConfigurableBinaryProvider];
  }
  if (isRetiredGrokLauncherPath(active.claude ?? "")) delete active.claude;
  Object.assign(runtimeBinaryPaths, active);
}

export function runtimeProviderBinaryPath(
  provider: ConfigurableBinaryProvider,
): string | null {
  const path = runtimeBinaryPaths[provider];
  return typeof path === "string" && path.trim() ? path.trim() : null;
}

export function loadProviderBinaryPath(
  provider: ConfigurableBinaryProvider,
): string | null {
  const path = readProviderBinaryPaths()[provider];
  return typeof path === "string" && path.trim() ? path.trim() : null;
}

export function providerBinaryPathChangePending(
  provider: ConfigurableBinaryProvider,
): boolean {
  return runtimeProviderBinaryPath(provider) !== loadProviderBinaryPath(provider);
}

export function saveProviderBinaryPath(
  provider: ConfigurableBinaryProvider,
  path: string | null,
): boolean {
  try {
    const stored = readProviderBinaryPaths();
    const value = path?.trim();
    if (value) stored[provider] = value;
    else delete stored[provider];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}
