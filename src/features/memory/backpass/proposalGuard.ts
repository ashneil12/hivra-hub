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
/** A letter that looks like a Latin one but is not: a Cyrillic "с" in "sсh://". */
const LOOKALIKE = /[а-яёα-ω]/g;
/** The Latin letter each lookalike stands for. */
const LATIN_FOR: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i", ј: "j", ԁ: "d", ԛ: "q", ԝ: "w", ɡ: "g",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", γ: "y", ω: "w",
};

/**
 * The text as the matchers below read it: Unicode folded to one form, zero-width characters gone, curly quotes made
 * plain, one space everywhere, and the usual ways of hiding a character spelled back out (`[.]`, ` dot `, `[at]`).
 * A phrase wrapped across a line or typed with a curly apostrophe is the same phrase to a person, so it is here too.
 */
export function normalised(text: string): string {
  let value = String(text ?? "")
    .normalize("NFKC")
    // A name written with a capital in the middle ("allowAllTools") is the words a person reads.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(ZERO_WIDTH, "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .toLowerCase()
    // A letter that looks like a Latin one but is not ("sсh://" with a Cyrillic c) is read as the word a person sees.
    .replace(LOOKALIKE, (letter) => LATIN_FOR[letter] ?? letter);
  value = value
    .replace(/\[\s*at\s*\]|\(\s*at\s*\)/g, "@")
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\(\s*dot\s*\)/g, ".")
    .replace(/\s+dot\s+/g, ".");
  value = value
    .replace(/。/g, ".")
    // The same dot and at sign written as a character reference or a percent escape.
    .replace(/&#(?:0*46|x0*2e);/g, ".")
    .replace(/&#0*64;|&#x0*40;/g, "@")
    .replace(/%2e/g, ".")
    .replace(/%40/g, "@")
    // "evil{.}com" is the dot spelled out; the "{.}" form is read by the URL rule on the text as written, because a
    // person writes braces in code too ("fn(name: {id})").
    .replace(/\[\s*\{?\s*\.\s*\}?\s*\]/g, ".");
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
/**
 * A phone number, not a date: "415 555 0100", "+1 (415) 555-0100", "+4412345678", but not "2026.11.06" (a date is
 * written with dots) and not "2026 11 06" (three groups of four or fewer are a date too).
 */
const PHONE =
  /(?:\+\d[\d\s()-]{7,}\d)|(?:\d{3,4}[\s-]\d{3,4}[\s-]\d{2,4})|(?:\(\d{2,4}\)[\s.-]?\d{3,4}[\s.-]\d{2,4})/;
/** A number typed in groups with a separator ("415 555 0100"), which a date's dots are not. */
const PHONE_SEPARATOR = /(?:\d[\s-]){4,}\d/;
const CC = /\b(?:cc|bcc)\b/;
const FORWARD_TO = /\bforward(?:ed|ing)? (?:it |them |this |that |emails? |messages? )?to\b/;
const ALSO_SEND_TO = /\b(?:also|always) send (?:\w+ ){0,3}to\b/;
const ADD_RECIPIENT = /\badd (?:\w+ ){0,2}(?:to|as) (?:the )?recipients?\b/;
/** The same, said about a thread, a chat or a thread's people: "add Alice to the thread", "add Sam to the channel". */
const ADD_TO_THREAD = /\badd (?:\w+ ){0,3}to (?:the |a |an )?(?:thread|conversation|chat|channel|group|call|invite|mailing list)\b/;
const COPY_IN_ON = /\bcopy (?:\w+ ){0,2}in on\b/;
/** Looping a person in is adding a recipient: "loop in Alice", "loop Sam in". */
const LOOP_IN = /\bloop(?:ing)? (?:\w+ ){0,2}in\b/;
/**
 * A send word, then within a sentence a "to" or "on" and a named person, team or channel; or the send word taking a
 * person as its object ("send me", "email them"). A bare "with" counts ("share with Bob"), and a name right after the
 * word ("tell Bob", "tweet it", "text it to Bob") counts too. "in" is left out: "reply in plain words" names no one.
 */
const SEND_TO_A_PERSON =
  /\b(?:send|sends|email|emails|forward|forwards|copy|copies|mail|mails|text|texts|slack|slacks|tell|tells|told|cc|bcc|notify|notifies|post|posts|message|messages|dm|dms|share|shares|invite|invites|reply|replies|ping|pings|alert|alerts|tweet|tweets)\b(?:[^.!?\n]{0,40}?\s(?:to|on|with)\s(?:the |my |a |an |our |their |every |all )?[a-z0-9@._#-]|\s+(?:me|him|her|them|us)\b)/;
/**
 * A handle or a capitalised name used as the object of a send: "Notify @alice", "tell Bob", "message Bob". The name
 * has to be written as a name (a capital, or a handle), so "link text that explains where it goes" is not one. A
 * lowercase name is read only where the word cannot be about anything else ("tell alex@", "ping alice,").
 */
const SEND_A_HANDLE =
  /\b(?:[Nn]otify|[Pp]ing|[Dd]m|[Mm]ention|[Mm]essage|[Ss]lack|[Tt]ell|[Tt]ext|[Mm]ail|[Cc]all|[Tt]weet)\s+(?:@[A-Za-z0-9_]{2,}|[A-Z][a-z][A-Za-z0-9_.-]*)/;
/**
 * A name written in lower case, right after a word that only takes a person: "tell bob", "message bob when done",
 * "ping alice@". The name must be the object, so "link text that explains where it goes" is not a recipient.
 */
const SEND_A_LOWER_NAME =
  /\b(?:tell|text|mail|dm|message|notify|ping)\s+(?!(?:me|us|them|him|her|it|this|that|the|a|an|my|our|your|when|if|what|how|why|whether|which|about|before|after|again|back|link|code|line|file|note|branch|build|test|check|docs?|api|endpoint|command|tool|workflow|run|it)\b)[a-z][a-z0-9_.-]*/;
/** "tell the team", "notify the team", "slack the team": a named group is a recipient. */
const SEND_A_GROUP =
  /\b(?:notify|ping|dm|mention|message|slack|tell|text|mail|tweet)\s+(?:the|our|all)\s+(?:team|group|channel|list|staff|customers?|clients?|users?|people|folks|everyone)\b/;
/** A bare tool that sends, used on its own: "tweet it", "tweet the launch". */
const SEND_A_TOOL = /\b(?:tweet|post|share|mail|text|slack|dm|ping)\s+(?:it|the \w+|them)\b/;
/**
 * "let Priya know" / "let the team know": the person who is told is named before the word that says so, which no
 * other send phrase does. "let me know" and "let it know" tell the writer, not someone else, so they pass.
 */
const LET_KNOW =
  /\blet(?:ting)?\s+(?!(?:me|us|it|this|that|alone|well|rest)\b)(?!know\b)[a-z0-9@._-]+(?:\s+[a-z0-9@._-]+){0,3}?\s+know\b/;
/**
 * A bare "ping", with no person or thing it pings: the words an agent writes beside a name ("Ping Priya"), or the
 * name of a call it means to make, are both a message to someone. It is read as a whole word, so "pinging the host"
 * is left alone unless it names a person.
 */
const BARE_PING = /\bping\b/i;

/**
 * A mail field that names who a message goes to. "to: alice" is a recipient; "Read user.id" is not, so the field name
 * must be one a mail header uses, and a field called "id" or "status" is not.
 */
const MAIL_FIELD = /(?:^|[\s;,])(?:to|cc|bcc|mail[- ]?to|send[- ]?to|deliver[- ]?to)\s*:\s*[a-z0-9@._#'"-]/;
/** The same field written as a markdown list item or a bold label: "- To: alice", "**Cc:** bob". */
const MAIL_FIELD_LIST = /(?:^|\n)\s*(?:[-*+]|\d+\.)?\s*\**(?:to|cc|bcc)\**\s*:\s*\S/;
/** A scheme that can carry a page, a file, a script or a session, not just a web link. */
const SCHEME =
  /\b(?:https?|hxxps?|ftps?|ssh|sftp|file|data|javascript|vbscript|ws|wss|mailto|tel|gopher|ldap|ldaps|telnet|smb|nfs|s3|gs|ipfs|magnet|chrome|about|moz-extension|chrome-extension|vscode|intent|content|blob|urn|news|irc|sip|xmpp|steam|spotify|slack|discord|tg|whatsapp|bitcoin|ethereum|solana|dns|whois|redis|postgres|postgresql|mysql|mongodb|amqp|jdbc|odbc|ftp|rtsp|mms|nntp|dict|gopher|z39\.50|jabber|skype):/;
/** A markdown link, whose target is a path or address whatever it says: "[the docs](/x)". */
const MARKDOWN_LINK = /\[[^\]\n]{1,80}\]\([^)\n]{1,200}\)/;
/**
 * A host written as numbers, in the places one is used: after a word that can host it ("at", "from", "server",
 * "the", "use"), or in a link. A date and a version ("2026.11.06", "v1.2.3") have a digit or a letter right before
 * them, and are not read as an address.
 */
const IP_HOST =
  /(?:\b(?:at|from|to|on|into|server|host|use|see|open|visit|address|ip|http:\/\/|https:\/\/|ssh |scp )\s*|[("'=[:\/])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
/** A host with a port: "localhost:3000/admin", "db.internal:5432". */
const HOST_WITH_PORT = /\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{2,5}\b/;
/**
 * A host ending in a country domain that is also a common file extension. "install.sh" on its own is a file, but
 * "from evil.sh" or "curl evil.sh" is an address.
 */
const FETCHED_SH =
  /\b(?:from|at|visit|open|curl|wget|fetch|download|go to|see|fetch)\s+(?:https?:\/\/)?[a-z0-9-]+\.(?:sh|py|pl|rs|md|js|ts|cc)\b/;
const SHORTENER =
  /\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rb\.gy|tiny\.cc|lnkd\.in|rebrand\.ly|s\.id|wp\.me|po\.st|qr\.gg|shorturl\.at|tiny\.one|bl\.ink|trib\.al|surl\.li)\b/;
/**
 * A real top-level domain. Every common file extension that is also a country's domain (sh, md, py, pl, rs, cc) is
 * left out on purpose, so "install.sh", "README.md" and "notes.txt" are not read as links.
 */
const TLDS =
  "com|org|net|io|ai|dev|co|uk|info|biz|gov|edu|example|test|xyz|site|online|ru|cn|de|fr|jp|au|ca|us|eu|nl|se|no|fi|dk|it|es|pt|ch|be|ie|nz|sg|hk|kr|in|br|mx|ar|za|tr|il|ae|tv|ws|gg|ly|to|fm|so|la|tw|vn|th|my|ph|cl|gl|gd|gy|st|store|shop|club|top|link|click|live|news|pro|mobi|cloud|tech|blog|website|space|fun|icu|buzz|wiki|zone|network|today|world|life|group|agency|company|solutions|services|team|digital|media|studio|design|chat|fit|run|win|review|global|guru|expert|rocks|ninja|cat|ltd|inc|llc|bio|art|page|host|press|party|racing|trade|cricket|science|stream|work|one|zero|plus|best|vip|cool|museum|travel|aero|coop|jobs|tel|asia|post|ml|tk|ga|cf|gq|pw|su|zip|mov|download|rest|country|kim|men|date|faith|accountant|loan|bid|cam";
/**
 * A host and a real top-level domain: "evil.com", "docs.intranet.example", "evil.museum". The extensions a person
 * also writes after a member of an object or a file name (id, name, md, js, json, txt, ts) are left out of the list,
 * so "user.id", "file.name" and "README.md" are not read as links. A reverse-domain package name
 * ("com.example.app") is read as a name, not a host, by `hostIn`.
 */
const TLD = new RegExp(`\\b[a-z](?:[a-z0-9-]*[a-z])?(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b`);
const HOST_INLINE = new RegExp(`\\b[a-z0-9-]+\\.[a-z0-9-]*(?:${TLDS})\\b`);
/** A reverse-domain package name: "com.example.app". */
const PACKAGE_NAME = /(?:^|[^a-z0-9.-])(?:com|org|net|io|dev|example)\.[a-z0-9-]+\.[a-z0-9-]+\b/g;
/** The literal "{.}" form, on the text as written: only a host ever puts braces where its dot belongs. */
const BRACED_DOT = /[a-z0-9-]\{\.\}(?:com|net|org|io|dev|ai|co|ru|cn|uk|info|biz|xyz|ml|tk|museum|zip)\b/i;
/** A dot with a space round it, which a sentence and a code path never do: "evil . com" is a host. */
const HOST_WITH_SPACED_DOT = /\b[a-z0-9-]{2,}\s\.\s(?:com|net|org|io|dev|ai|co|ru|cn|uk|info|biz|xyz|ml|tk|museum|zip)\b/;

/**
 * Whether the text holds a host. A package name is set aside, but still counts when a link word, a path or a port is
 * written into it ("https://com.example.app/x"), because that is an address however it was named. A line that is
 * nothing but a host is a link even when its last label is one people also write in code ("example.com").
 */
function hostIn(value: string): boolean {
  if (/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\//.test(value) || HOST_WITH_PORT.test(value)) return true;
  // The word in front of a package name is kept, so "open com.example.app" still reads as one word before the name.
  const withoutPackages = value.replace(PACKAGE_NAME, " ");
  if (TLD.test(withoutPackages)) return true;
  const lines = withoutPackages.split(/[\n.!?]\s*/);
  return lines.some((line) => /^[\s"'([{*_-]*[a-z0-9-]+(?:\.[a-z0-9-]+)+\s*["')\]}*]*$/.test(line) && HOST_INLINE.test(line));
}

/** The words that name a secret in prose: "the API key", "your password". Naming one is enough to refuse the edit. */
const CREDENTIAL_TOPIC =
  /\b(?:the |a |an |any |your |my |our )?(?:token|key)[-_ ]?(?:budget|counter|limit|usage|quota|cost|price|rate)\b|\b(?:password|secret|key)[-_ ]?(?:policy|policies|rotation|rules?|strength|length|manager|management)\b|\bcommit(?:ting)? (?:no )?(?:secrets|keys|passwords)\b|\bnever commit (?:secrets|keys|passwords)\b/;
const CREDENTIAL =
  /\b(?:passwords?|passcodes?|passphrases?|pin (?:codes?|numbers?)|api[ _-]?keys?|private keys?|ssh keys?|credentials?|log ?in details|sign[- ]in details)\b/;
/** The same words where they mean a value rather than a topic: "your secrets", "their token". */
const CREDENTIAL_POSSESSIVE = /\b(?:your|their|his|her|our|the|my|its|a|an|any)\s+(?:secrets?|tokens?)\b/;
const SECRET_WORD = "(?:keys?|tokens?|secrets?|passwords?|passwd|pwd|credentials?|auth)";
/** A name a shell reads as a secret: OPENAI_API_KEY, GH_TOKEN, DB_PASSWORD. */
const SECRET_NAME = new RegExp(`\\b[a-z0-9]+(?:_[a-z0-9]+)*_${SECRET_WORD}\\b`);
/** A file whose name says it holds a secret: "secrets.yaml", "token.txt", "private.key". */
const SECRET_FILE = new RegExp(`\\b${SECRET_WORD}s?[-_.][a-z0-9]{1,20}\\b`);
/**
 * A base64 blob: a long run of the base64 alphabet with several capitals and a digit in it. Plain prose in lower
 * case, or a run of ordinary words, is not one.
 */
const BASE64_BLOB = /(?=(?:[^A-Z]*[A-Z]){3})(?=[^0-9]*[0-9])[A-Za-z0-9+/]{32,}={0,2}/;

/**
 * Whether the text holds a base64 blob: one whitespace-separated token, or a token that carries on across a line break
 * ("Qk9C...\nNDU2..."). Spaces are not removed first: that fused prose words into a run that looked like a blob
 * ("## A correction from the week" and "Correction 0." read as one) and refused plain edits (review H5).
 */
function base64Blob(text: string): boolean {
  const visible = text.replace(ZERO_WIDTH, "");
  if (visible.split(/\s+/).some((token) => BASE64_BLOB.test(token))) return true;
  return BASE64_BLOB.test(visible.replace(/\r?\n[ \t]*/g, ""));
}
/**
 * A value assigned to a key name, even when the value starts on the next line: "key=\nabcdefghijklmnop". A short
 * value is still a value ("pwd=x", "passwd: x", "token: abc123"): the name is a secret and something follows it.
 */
const ASSIGNED_KEY = new RegExp(`(?:^|[^a-z0-9_])(?:[a-z0-9]+_)*${SECRET_WORD}\\b[a-z0-9_-]*\\s*[:=]\\s*["']?(?!(?:policy|policies|rotat\\w*|handling|management|reset)\\b)[a-z0-9._~+/-]+`);
/** The same, on the text as written, because normalised reads the capitals out of "glpat-xYz12abc". */
const TOKEN_PREFIX_AS_WRITTEN = new RegExp(
  "(?:\\b(?:github_pat|glpat|dop_v1)[-_][A-Za-z0-9_-]{12,}" +
    "|\\b(?:ghp|gho|ghu|ghs|ghr|hf|xai|npm|sbp|akia|asia|shpat)[-_][A-Za-z0-9_-]{12,}" +
    "|\\b(?:sk|pk|rk)[-_](?=[A-Za-z0-9_-]{12,})(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{12,})",
);
/** A scheme, a login and a password written into one address: "postgres://u:p@h", "redis://:p@h". */
const URL_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/]*:[^\s/@]*@/;
/** A Basic or Digest header carries a login whatever its tail looks like. */
const BASIC_AUTH = /\b(?:authorization|auth)\s*:\s*(?:basic|digest|ntlm)\b/;
/**
 * A secret written as a variable or an option whose value says it is a value: "token=abc123", "password=abc",
 * "pwd: x1". A lower case value too ("pwdx"), because a variable is assigned one; a line of code that mentions
 * "password policy" is caught by CREDENTIAL_TOPIC and set aside first.
 */
const HANDS_OVER_ASSIGNED =
  /\b(?:token|secret|password|passwd|pwd|authorization|auth|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{1,}/i;
/** An HTTP bearer or basic credential: "Authorization: Bearer abc.def.ghi", "Basic dXNlcjpwYXNz". */
const HAS_BEARER = /\bbearer\s+[A-Za-z0-9._~+/-]{3,}/i;
const HAS_BASIC = /\bbasic\s+[A-Za-z0-9+/=]{4,}/i;

/**
 * A config key that grants permission, in any spelling: allow_all_tools, allowAllTools (read as words by normalised),
 * approval_policy, trust_level, autopilot, acceptEdits, bypassPermissions.
 */
const PERMISSION_KEY =
  /\b(?:allow|permit|trust|enable|give|grant)[_ -]?(?:all|every|any)[_ -]?\w*|\ballow(?:ed)?[_ -]?tools?\b|\bpermissions?\b|\bauto_?approve\w*|\b(?:ask|approval|permission)[_ -]?(?:for[_ -]?)?(?:approval|policy|mode)\b|\btrust[_ -]?level\b|\bautopilot\b|\bbypass_?permissions?\b|\baccept[_ -]?edits?\b|\bdangerously[_ -]?skip\w*|\bno[_ ]?sandbox\b|\bsandbox[_ ]?mode\b/;
/** A tool rule that allows a tool, its commands or everything: "Bash(*)", "Bash(rm:*)", "Write(*)". */
const TOOL_RULE = /\b[a-z][a-z0-9_]*\s*\(\s*(?:[a-z0-9._*:/ -]*[:*]\s*)?\*\s*\)/;
/** A tool list that names tools to allow with no limit: "allowedTools: Bash, Read". */
const TOOL_LIST_VALUE = /\ballowed[_ -]?tools?\b\s*[:=]\s*\[?\s*"?[a-z]/;

const PERMISSION =
  /\bwithout (?:asking|approval|confirmation|checking|permission|prompting|review)\b|\bskip(?:ping)? (?:the )?(?:asks?|approvals?|confirmations?|prompts?|reviews?|checks?|permissions?)\b|\bauto[- ]?approv\w*|\b(?:don'?t|do not|never) (?:ask|prompt|wait for|wait on) (?:for )?(?:approval|permission|first|before|me(?! to repeat)|him|her|them|the person|a person|anyone|review|confirmation|it)\b|\b(?:never|don'?t|do not) ask\b(?!\s+(?:me\s+)?(?:to repeat|me to repeat|again|about|how|what|why|whether|which|questions?))|\bno need (?:to ask|for permission)\b|\byou (?:don'?t|do not) need (?:to ask|permission)\b|\b(?:assume|grant yourself) permission\b|\bno confirmation (?:is )?(?:needed|required)\b|\bconfirmation (?:is )?not (?:needed|required)\b|\b(?:full|unrestricted|root) (?:autonomy|access|permission)\b|\bhands[- ]off\b|\bgrant(?:ed|ing)? (?:\w+ ){0,2}(?:access|permissions?|admin)\b|\bgive (?:\w+ ){0,2}(?:access|permissions?|admin)\b|\bbypass\w*|\b(?:disable|turn off|switch off|ignore|override) (?:\w+ ){0,2}(?:approvals?|permissions?|reviews?|safety|guards?|checks?)\b|\b(?:always|trust) (?:allow|approve)\b|\b(?:allow|approve) (?:all|every|any|anything|everything)\b|\b(?:allow|approve|enable|permit|run) (?:all|every|any) (?:tools?|commands?)\b|\btrust (?:all|every|anything|everything)\b|\bstop asking\b|\byes to all\b|\bassume (?:yes|consent)\b|\banswer yes to (?:every|all)\b|\bact on your own\b|\bno (?:further )?approvals? (?:are )?(?:needed|required)\b|\byolo\b|\bapprove[- ]all\b|\bpre-?approved?\b|\btreat (?:every|all|any) \w+ as (?:approved|allowed)\b|\b(?:have|has|you may) (?:my |his |her |their |your )?(?:full |unrestricted )?permission to\b|\bnever wait (?:for|on)? ?(?:review|approval|confirmation|the review)?\b|\b(?:bash|shell|all|any|every)\s*\(\s*\*\s*\)|\ballowed[-_ ]?tools?\b|\b(?:approval|permission)[_ -]?(?:policy|mode)\b|\bsandbox[_ ]?mode\b|\bdanger[-_ ]?full[-_ ]?access\b|\bdelete files freely\b|\bsudo is (?:fine|ok|okay)\b|\bchmod 777\b|\bunprompted\b/;


/**
 * The evidence link a weekly retro writes to its own work log: "[work log 2026-11-10](work-log:2026-11-10)". It is the
 * app's own form, not a web address, so it is taken out before the matchers read the text. Only that exact shape, with
 * a day on both sides, is taken out; a link to anything else still reads as a link (review H5).
 */
const INTERNAL_WORK_LOG_LINK = /\[work log \d{4}-\d{2}-\d{2}\]\(work-log:\d{4}-\d{2}-\d{2}\)/gi;

/** What `text` adds that a proposal may not, by kind; empty when it adds none of them. */
export function additionsIn(text: string): Addition[] {
  const original = String(text ?? "").replace(INTERNAL_WORK_LOG_LINK, " ");
  const value = normalised(original);
  if (!value) return [];
  // Words that name a topic rather than carry a value ("the token budget", "the password policy") are taken out before
  // the matchers read the rest, so ordinary direction is not refused.
  const topical = value.replace(CREDENTIAL_TOPIC, " topic ");
  const found: Addition[] = [];
  if (
    EMAIL.test(value) ||
    HANDLE.test(value) ||
    PHONE.test(value) ||
    PHONE_SEPARATOR.test(value) ||
    FORWARD_TO.test(value) ||
    ALSO_SEND_TO.test(value) ||
    ADD_RECIPIENT.test(value) ||
    COPY_IN_ON.test(value) ||
    SEND_TO_A_PERSON.test(value) ||
    SEND_A_HANDLE.test(value) ||
    SEND_A_LOWER_NAME.test(value) ||
    SEND_A_GROUP.test(value) ||
    SEND_A_TOOL.test(value) ||
    LET_KNOW.test(value) ||
    BARE_PING.test(value) ||
    ADD_TO_THREAD.test(value) ||
    LOOP_IN.test(value) ||
    CC.test(value) ||
    MAIL_FIELD.test(` ${value}`) ||
    MAIL_FIELD_LIST.test(value)
  ) {
    found.push("recipient");
  }
  if (
    SCHEME.test(value) ||
    SHORTENER.test(value) ||
    hostIn(value) ||
    MARKDOWN_LINK.test(value) ||
    BRACED_DOT.test(original) ||
    HOST_WITH_SPACED_DOT.test(original.toLowerCase()) ||
    IP_HOST.test(value) ||
    HOST_WITH_PORT.test(value) ||
    FETCHED_SH.test(value) ||
    /\bwww\./.test(value)
  )
    found.push("url");
  // Token shapes are case-sensitive (AKIA…, ghp_…, sk-…), so they are read on the text as written; a key hard-wrapped
  // over two lines is one key, so the same shapes are read with the spaces and line breaks taken out as well.
  const unwrapped = original.replace(ZERO_WIDTH, "").replace(/\s+/g, "");
  if (
    CREDENTIAL.test(topical) ||
    CREDENTIAL_POSSESSIVE.test(topical) ||
    SECRET_NAME.test(topical) ||
    SECRET_FILE.test(topical) ||
    URL_PASSWORD.test(unwrapped.toLowerCase()) ||
    BASIC_AUTH.test(value) ||
    HAS_BEARER.test(value) ||
    HAS_BASIC.test(value) ||
    HANDS_OVER_ASSIGNED.test(topical) ||
    /\bPAT\b/.test(original) ||
    TOKEN_PREFIX_AS_WRITTEN.test(original) ||
    TOKEN_PREFIX_AS_WRITTEN.test(original.replace(ZERO_WIDTH, "").replace(/\s+/g, "")) ||
    ASSIGNED_KEY.test(unwrapped.toLowerCase()) ||
    base64Blob(original) ||
    hasSecretText(topical) ||
    hasSecretText(unwrapped)
  ) {
    found.push("credential");
  }
  if (PERMISSION.test(value) || PERMISSION_KEY.test(value) || TOOL_RULE.test(value) || TOOL_LIST_VALUE.test(value))
    found.push("permission");
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
