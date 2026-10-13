import { invoke } from "@tauri-apps/api/core";
import type { HarnessId } from "../../sessions/model/session";

export type ConfigurableBinaryProvider = HarnessId;

const STORAGE_KEY = "monocode.providerBinaryPaths.v1";

// The CC Studio build supplies its wrapper. Other builds retain normal CLI lookup.
const ccStudioBinary = import.meta.env.VITE_CC_STUDIO_CLAUDE_BINARY?.trim();

function effectiveBinaryPaths(): StoredBinaryPaths {
  const paths = readProviderBinaryPaths();
  if (ccStudioBinary && !paths.claude?.trim()) paths.claude = ccStudioBinary;
  return paths;
}

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

const runtimeBinaryPaths = effectiveBinaryPaths();

export async function initializeProviderBinaryPaths(): Promise<void> {
  const active = await invoke<StoredBinaryPaths>("harness_runtime_binary_paths", {
    paths: effectiveBinaryPaths(),
  });
  for (const provider of Object.keys(runtimeBinaryPaths)) {
    delete runtimeBinaryPaths[provider as ConfigurableBinaryProvider];
  }
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
  const path = effectiveBinaryPaths()[provider];
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

/** Proxy model IDs are valid only for the CC Studio launcher, never stock CC. */
export function isCcStudioClaudeRuntime(): boolean {
  const path = runtimeProviderBinaryPath("claude");
  return !!path && (
    path === ccStudioBinary ||
    /(?:^|[\\/])cc-studio-claude$/.test(path)
  );
}
