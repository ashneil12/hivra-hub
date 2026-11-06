// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer packages/git-attribution session trailer (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import { validId } from "../../session-attribution";

const TRAILER = /^[A-Za-z0-9-]+:[ \t](.*)$/;

export type Trailers = { chat: string | null; task: string | null };

/** The trailer block at the end of a message. A blank line or a normal line ends it. */
export function trailerBlock(message: string): string[] {
  const lines = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const block: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (line === "") break;
    if (!TRAILER.test(line)) break;
    block.push(line);
  }
  block.reverse();
  return block;
}

function valueOf(line: string, name: string): string | null {
  const match = TRAILER.exec(line);
  if (!match) return null;
  const token = line.slice(0, line.indexOf(":"));
  if (token !== name) return null;
  return validId((match[1] ?? "").trim());
}

/** Hivra-Chat and Hivra-Task from the trailer block only. An invalid id is ignored. */
export function trailers(message: string): Trailers {
  let chat: string | null = null;
  let task: string | null = null;
  for (const line of trailerBlock(message)) {
    if (chat === null) chat = valueOf(line, "Hivra-Chat");
    if (task === null) task = valueOf(line, "Hivra-Task");
  }
  return { chat, task };
}
