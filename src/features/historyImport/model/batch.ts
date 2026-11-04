// Translated from Raven raven/importer/orchestrator.py _feed_session
// (Apache-2.0). The upstream file does not carry a separate copyright line.
// Licence: src/features/historyImport/vendor/raven-LICENSE.
//
// The size check happens before a message is appended, so one oversized
// message is its own batch. The bounds are part of how a long chat is split.

import { BATCH_CHAR_LIMIT, BATCH_MSG_LIMIT, type TranscriptMessage } from "./types";

export function batchesOf(messages: readonly TranscriptMessage[]): TranscriptMessage[][] {
  const batches: TranscriptMessage[][] = [];
  let batch: TranscriptMessage[] = [];
  let chars = 0;
  for (const message of messages) {
    const size = message.content.length;
    if (batch.length > 0 && (batch.length >= BATCH_MSG_LIMIT || chars + size > BATCH_CHAR_LIMIT)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(message);
    chars += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Raven's _pause: wait in one-second slices so a cancel lands during a retry.
 * Returns false when it was cancelled.
 */
export async function slicePause(
  ms: number,
  cancelled: () => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let left = ms;
  while (left > 0) {
    if (cancelled()) return false;
    const slice = Math.min(1000, left);
    await sleep(slice);
    left -= slice;
  }
  return !cancelled();
}
