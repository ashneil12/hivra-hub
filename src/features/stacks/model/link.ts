// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer apps/devstack routes (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import { invoke } from "@tauri-apps/api/core";

/** A local app URL, or null. Anything else read from disk is not a link. */
export function appLink(url: string | null | undefined): string | null {
  if (!url || url.length > 200) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return null;
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
