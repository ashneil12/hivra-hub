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

const ZERO_WIDTH = /[­​-‏‪-‮⁠-⁤﻿]/g;

/**
 * The text as the matchers below read it: Unicode folded to one form, zero-width characters gone, curly quotes made
 * plain, one space everywhere, and the usual ways of hiding a character spelled back out (`[.]`, ` dot `, `[at]`).
 * A phrase wrapped across a line or typed with a curly apostrophe is the same phrase to a person, so it is here too.
 */
export function normalised(text: string): string {
  let value = String(text ?? "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .toLowerCase();
  value = value
    .replace(/\[\s*at\s*\]|\(\s*at\s*\)/g, "@")
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\(\s*dot\s*\)/g, ".")
    .replace(/\s+dot\s+/g, ".");
  value = value.replace(/。/g, ".");
  // Text written out one character at a time ("h t t p s : / / e v i l . c o m") is one address to a reader.
  const tokens = value.split(" ").filter(Boolean);
  if (tokens.length >= 5 && tokens.filter((t) => t.length === 1).length * 2 >= tokens.length) {
    value = tokens.join("");
  }
  value = value
    .replace(/(\w)\s+@\s+(\w)/g, "$1@$2")
    .replace(/(\w)\s+\.\s+(\w)/g, "$1.$2")
    // "bob at example.com" is an address; "look at the." is not, and has nothing after its dot.
    .replace(/\b([a-z0-9._+-]{1,30}) at ([a-z0-9-]{1,40}\.[a-z0-9-]{1,20})\b/g, "$1@$2");
  return value.replace(/\s+/g, " ").trim();
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const HANDLE = /(?:^|[^\w@])@[A-Za-z0-9_]{2,}(?![\w@])/;
const PHONE = /\+?\d[\d ().-]{7,}\d/;
const CC = /\b(?:cc|bcc)\b/;
const FORWARD_TO = /\bforward(?:ed|ing)? (?:it |them |this |that |emails? |messages? )?to\b/;
const ALSO_SEND_TO = /\b(?:also|always) send (?:\w+ ){0,3}to\b/;
const ADD_RECIPIENT = /\badd (?:\w+ ){0,2}(?:to|as) (?:the )?recipients?\b/;
const COPY_IN_ON = /\bcopy (?:\w+ ){0,2}in on\b/;
/**
 * A send word, then within a sentence a "to" or "on" and a named person, team or channel; or the send word taking a
 * person as its object ("send me", "email them"). "in" is left out: "reply in plain words" names no one.
 */
const SEND_TO_A_PERSON =
  /\b(?:send|sends|email|emails|forward|forwards|copy|copies|cc|bcc|notify|notifies|post|posts|message|messages|dm|dms|share|shares|invite|invites|reply|replies|ping|alert)\b(?:[^.!?\n]{0,40}?\s(?:to|on)\s(?:the |my |a |an |our |their |every |all )?[a-z0-9@._#-]|\s+(?:me|him|her|them|us)\b)/;
/**
 * A handle or a bare name used as the object of a send: "Notify @alice", "ping alice". A word that names a thing
 * rather than a person or channel ("message the team", "ping the server") is not a recipient.
 */
const SEND_A_HANDLE =
  /\b(?:notify|ping|dm|mention)\s+(?!(?:the|a|an|my|our|it|them|me|here|there|back|again|when|if|server|service|build|test|check|docs?|api|endpoint|process|command|tool|workflow|run)\b)(?:@?[a-z][a-z0-9_.-]{1,})\b/;

/** A scheme that can carry a page, a file, a script or a session, not just a web link. */
const SCHEME = /\b(?:https?|hxxps?|ftps?|ssh|sftp|file|data|javascript|vbscript|ws|wss|mailto|tel):/;
/** A markdown link, whose target is a path or address whatever it says: "[the docs](/x)". */
const MARKDOWN_LINK = /\[[^\]\n]{1,80}\]\([^)\n]{1,200}\)/;
/** A host written as numbers: "192.168.1.5". */
const IP_HOST = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
/**
 * A host ending in a country domain that is also a common file extension. "install.sh" on its own is a file, but
 * "from evil.sh" or "curl evil.sh" is an address.
 */
const FETCHED_SH =
  /\b(?:from|at|visit|open|curl|wget|fetch|download|go to|see|fetch)\s+(?:https?:\/\/)?[a-z0-9-]+\.(?:sh|py|pl|rs|md|js|ts|cc)\b/;
const SHORTENER =
  /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rb\.gy|tiny\.cc|lnkd\.in|rebrand\.ly|s\.id|wp\.me|po\.st|qr\.gg|shorturl\.at|tiny\.one|bl\.ink|trib\.al|surl\.li)\b/;
/**
 * A host and a real top-level domain. Every common file extension that is also a country's domain (sh, md, py, pl,
 * rs, cc) is left out on purpose, so "install.sh", "README.md" and "notes.txt" are not read as links.
 */
const TLD =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|co|uk|info|biz|me|gov|edu|example|test|xyz|site|online|ru|cn|de|fr|jp|au|ca|us|eu|nl|se|no|fi|dk|it|es|pt|ch|be|ie|nz|sg|hk|kr|in|br|mx|ar|za|tr|il|ae|tv|ws|gg|ly|to|fm|so|la|tw|vn|th|id|my|ph|cl|gl|gd|gy|st|store|shop|club|top|link|click|live|news|pro|name|mobi|cloud|tech|blog|website|space|fun|icu|buzz|wiki|zone|network|today|world|life|email|group|agency|company|solutions|services|team|digital|media|studio|design|chat|fit|run|win|review|global|guru|expert|rocks|ninja|cat|ltd|inc|llc|bio|art|page|host|press|party|racing|trade|cricket|science|download|stream|work|one|zero|plus|best|vip|cool)\b/;

const CREDENTIAL =
  /\b(?:passwords?|passcodes?|passphrases?|pin (?:codes?|numbers?)|api[ _-]?keys?|secrets?|(?:access|auth|api|bearer|refresh|session) tokens?|bearer|private keys?|ssh keys?|credentials?|log ?in details|sign[- ]in details)\b/;
/** A name a shell reads as a secret: OPENAI_API_KEY, GH_TOKEN, DB_PASSWORD. */
const SECRET_NAME = /\b[a-z0-9]+(?:_[a-z0-9]+)*_(?:keys?|tokens?|secrets?|passwords?|passwd|credentials?)\b/;
/**
 * A base64 blob: a long run of the base64 alphabet with several capitals and a digit in it. Plain prose in lower
 * case, or a run of ordinary words, is not one.
 */
const BASE64_BLOB = /(?=(?:[^A-Z]*[A-Z]){3})(?=[^0-9]*[0-9])[A-Za-z0-9+/]{32,}={0,2}/;
/** A value assigned to a key name, even when the value starts on the next line: "key=\nabcdefghijklmnop". */
const ASSIGNED_KEY =
  /\b(?:keys?|tokens?|secrets?|passwords?|passwd|credentials?|auth|bearer)[a-z0-9_-]*\s*[:=]\s*[a-z0-9._~+/=-]{8,}/;
/** A token prefix with a long enough tail to be a key: sk-…, ghp_…, AKIA…, even split over a line. */
const TOKEN_PREFIX = /\b(?:sk|pk|rk|ghp|gho|ghs|ghr|hf|xai|npm|sbp|akia|asia)[-_]?[a-z0-9_-]{12,}/;

const PERMISSION =
  /\bwithout (?:asking|approval|confirmation|checking|permission|prompting|review)\b|\bskip(?:ping)? (?:the )?(?:asks?|approvals?|confirmations?|prompts?|reviews?|checks?|permissions?)\b|\bauto[- ]?approv\w*|\b(?:don'?t|do not|never) (?:ask|prompt|wait for|wait on) (?:for )?(?:approval|permission|first|before|me|him|her|them|the person|a person|anyone|review|confirmation)\b|\bno need to (?:ask|confirm)\b|\bno confirmation (?:is )?(?:needed|required)\b|\bconfirmation (?:is )?not (?:needed|required)\b|\b(?:full|unrestricted|root) (?:autonomy|access|permission)\b|\bhands[- ]off\b|\bgrant(?:ed|ing)? (?:\w+ ){0,2}(?:access|permissions?|admin)\b|\bgive (?:\w+ ){0,2}(?:access|permissions?|admin)\b|\bbypass\w*|\b(?:disable|turn off|switch off) (?:the )?(?:approvals?|reviews?|safety|guards?|checks?)\b|\b(?:always|trust) (?:allow|approve)\b|\b(?:allow|approve) (?:all|every|any|anything|everything)\b|\b(?:allow|approve) (?:all|every) (?:tools?|commands?)\b|\btrust (?:all|every) (?:tools?|commands?)\b|\bstop asking\b|\byes to all\b|\bassume yes\b|\banswer yes to (?:every|all)\b|\bact on your own\b|\bno (?:further )?approvals? (?:are )?(?:needed|required)\b|\byolo\b|\bdangerously[- ]?skip\w*|\bapprove[- ]all\b|\bpre-approved?\b|\btreat (?:every|all|any) \w+ as (?:approved|allowed)\b|\b(?:have|has|you may) (?:my |his |her |their |your )?(?:full |unrestricted )?permission to\b|\bnever wait (?:for|on)? ?(?:review|approval|confirmation|the review)?\b|\b(?:bash|shell|all|any|every)\s*\(\s*\*\s*\)|\ballowed[-_ ]?tools?\b|\b(?:approval|permission)[_ -]?(?:policy|mode)\b|\bsandbox[_ ]?mode\b|\bdanger[-_ ]?full[-_ ]?access\b|\bdelete files freely\b|\bsudo is (?:fine|ok|okay)\b|\bchmod 777\b|\bunprompted\b/;

/** What `text` adds that a proposal may not, by kind; empty when it adds none of them. */
export function additionsIn(text: string): Addition[] {
  const original = String(text ?? "");
  const value = normalised(original);
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
    COPY_IN_ON.test(value) ||
    SEND_TO_A_PERSON.test(value) ||
    SEND_A_HANDLE.test(value)
  ) {
    found.push("recipient");
  }
  if (
    SCHEME.test(value) ||
    SHORTENER.test(value) ||
    TLD.test(value) ||
    MARKDOWN_LINK.test(value) ||
    IP_HOST.test(value) ||
    FETCHED_SH.test(value) ||
    /\bwww\./.test(value)
  )
    found.push("url");
  // Token shapes are case-sensitive (AKIA…, ghp_…, sk-…), so they are read on the text as written; a key hard-wrapped
  // over two lines is one key, so the same shapes are read with the spaces and line breaks taken out as well.
  const unwrapped = original.replace(ZERO_WIDTH, "").replace(/\s+/g, "");
  if (
    CREDENTIAL.test(value) ||
    SECRET_NAME.test(value) ||
    /\bPAT\b/.test(original) ||
    TOKEN_PREFIX.test(unwrapped) ||
    ASSIGNED_KEY.test(unwrapped) ||
    BASE64_BLOB.test(unwrapped) ||
    hasSecretText(value) ||
    hasSecretText(unwrapped)
  ) {
    found.push("credential");
  }
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
