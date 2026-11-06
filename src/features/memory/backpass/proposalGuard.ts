// Copyright 2026 Row-Bot Contributors
// SPDX-License-Identifier: Apache-2.0
// Source: https://github.com/siddsachar/row-bot src/row_bot/evolution.py (injection_problems)
//
// WP-101: text a proposal adds reaches an agent's instructions, so it may not add a recipient, a link, a key or a
// permission grant, whoever's evidence it rests on. Only the added lines are read: a file that already carries a
// link can still be edited, and a proposal that merely says the word "link" is fine.
//
// Changed from Row-Bot: Python regular expressions became the matchers below; the four kinds are returned by name
// with a plain-English reason, and the check runs on what an edit adds rather than on a whole draft. Row-Bot's
// `contains_unredacted_sensitive_text` is Hivra's own `hasSecretText`.

import { hasSecretText } from "../../portable/model/secrets";
import type { Hunk } from "./diff";

export type Addition = "recipient" | "url" | "credential" | "permission";

/** Why each kind is refused, in the words a person reads. */
export const ADDITION_REASON: Record<Addition, string> = {
  recipient: "This edit adds someone to send to, so it wasn't used.",
  url: "This edit adds a link, so it wasn't used.",
  credential: "This edit adds a key or a password, so it wasn't used.",
  permission: "This edit asks to skip approvals or grant access, so it wasn't used.",
};

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const HANDLE = /(?:^|[^\w@])@[A-Za-z0-9_]{2,}(?![\w@])/;
const PHONE = /\+?\d[\d ().-]{7,}\d/;
const CC = /\b(?:cc|bcc)\b/i;
const FORWARD_TO = /\bforward(?:ed|ing)? (?:it |them |this |that |emails? |messages? )?to\b/i;
const ALSO_SEND_TO = /\b(?:also|always) send (?:\w+ ){0,3}to\b/i;
const ADD_RECIPIENT = /\badd (?:\w+ ){0,2}(?:to|as) (?:the )?recipients?\b/i;
const COPY_IN_ON = /\bcopy (?:\w+ ){0,2}in on\b/i;

const URL =
  /\b(?:https?|ftp):\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|io|ai|dev|app|co|uk|info|biz|me|gov|edu|example|test|xyz|site|online)\b/i;

const CREDENTIAL =
  /\b(?:passwords?|passcodes?|passphrases?|pin (?:codes?|numbers?)|api[ _-]?keys?|secrets?|(?:access|auth|api|bearer|refresh|session) tokens?|bearer|private keys?|ssh keys?|credentials?|log ?in details|sign[- ]in details)\b/i;

const PERMISSION =
  /\bwithout (?:asking|approval|confirmation|checking|permission)\b|\bskip(?:ping)? (?:the )?(?:approvals?|confirmations?|reviews?|checks?)\b|\bauto[- ]?approv\w*|\b(?:don'?t|do not|never) ask (?:for )?(?:approval|permission|first|before)\b|\bno need to (?:ask|confirm)\b|\bfull autonomy\b|\bhands[- ]off\b|\bgrant(?:ed|ing)? (?:\w+ )?(?:access|permissions?)\b|\bgive (?:\w+ ){0,2}(?:access|permissions?)\b|\bbypass\w*|\b(?:disable|turn off|switch off) (?:the )?(?:approvals?|reviews?|safety|guards?|checks?)\b|\balways (?:allow|approve)\b/i;

/** What `text` adds that a proposal may not, by kind; empty when it adds none of them. */
export function additionsIn(text: string): Addition[] {
  const value = typeof text === "string" ? text : "";
  if (!value) return [];
  const found: Addition[] = [];
  if (
    EMAIL.test(value) ||
    HANDLE.test(value) ||
    PHONE.test(value) ||
    CC.test(value) ||
    FORWARD_TO.test(value) ||
    ALSO_SEND_TO.test(value) ||
    ADD_RECIPIENT.test(value) ||
    COPY_IN_ON.test(value)
  ) {
    found.push("recipient");
  }
  if (URL.test(value)) found.push("url");
  if (CREDENTIAL.test(value) || hasSecretText(value)) found.push("credential");
  if (PERMISSION.test(value)) found.push("permission");
  return found;
}

/**
 * The material an edit adds: the inserted lines of each hunk, or a hunk's replacement text when it carries no lines.
 * Removed and unchanged lines are never read, so a rewrite that keeps a link the file already had is fine.
 */
export function addedText(hunks: readonly Hunk[] | null | undefined): string {
  if (!Array.isArray(hunks)) return "";
  const parts: string[] = [];
  for (const hunk of hunks) {
    if (!hunk || typeof hunk !== "object") continue;
    const lines: Hunk["lines"] = Array.isArray(hunk.lines) ? hunk.lines : [];
    const inserted = lines.filter((line) => line && line.type === "ins" && typeof line.text === "string");
    if (inserted.length) {
      for (const line of inserted) parts.push(line.text);
    } else if (typeof hunk.replace === "string" && hunk.replace) {
      parts.push(hunk.replace);
    }
  }
  return parts.join("\n");
}

/** Why an edit's added material can't be used, or null when it can. */
export function refusalFor(hunks: readonly Hunk[] | null | undefined): string | null {
  const found = additionsIn(addedText(hunks));
  return found.length ? ADDITION_REASON[found[0]] : null;
}
