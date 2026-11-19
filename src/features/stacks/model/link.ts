// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer apps/devstack routes (Apache-2.0).
// Translated to Rust in the app's stack code. This file is not a byte copy.

import { invoke } from "@tauri-apps/api/core";

/** One DNS label, as the app publishes them: lowercase letters, digits and inner hyphens. */
const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
/** One label (`shop-wp-90`) or a fake service's two (`github.shop-wp-90`). */
const PUBLISHED_NAME = new RegExp(`^${LABEL}(\\.${LABEL})*$`);

/** A loopback URL or one published name (`shop-wp-90.localhost`), or null. */
export function appLink(url: string | null | undefined): string | null {
  if (!url || url.length > 300) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname;
  // `.localhost` resolves to loopback by itself (RFC 6761); anything else is not ours.
  const name = host.endsWith(".localhost") ? host.slice(0, -".localhost".length) : "";
  const named = name.length > 0 && PUBLISHED_NAME.test(name);
  if (host !== "127.0.0.1" && host !== "localhost" && !named) return null;
  return url;
}

type StackStatus = { url?: string | null };

/** The running app for this checkout, or null when there is nothing local to open. */
export async function stackUrlFor(cwd: string): Promise<string | null> {
  try {
    const status = await invoke<StackStatus | null>("stack_status", { cwd });
    return appLink(status?.url);
  } catch {
    return null;
  }
}
