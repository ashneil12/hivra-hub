// Ash's red list: what autopilot never decides, however long he is away (Ash, 19 Oct). A call that touches any of these
// waits for him in Needs you. Two checks guard it and the stricter wins: the agent may mark a call red itself, and the
// text of every call (its question, options, recommendation, a tool's command) is read here. A miss here would be the
// one way autopilot could do something on the list, so the patterns lean to holding: a held call costs Ash one tap, a
// taken one can't be undone.
import { forUser } from "../../hub/model/userName";
import { credentialInWords, credentialInText } from "./credentialPaths";

export type RedCategory =
  | "money"
  | "delete"
  | "prod-host"
  | "mass-destructive"
  | "send-as-ash"
  | "credentials";

export const RED_LIST: readonly { id: RedCategory; label: string }[] = [
  { id: "money", label: "Moving money, refunds or charges" },
  { id: "delete", label: "Deleting data without a restorable backup" },
  { id: "prod-host", label: "Production host maintenance" },
  { id: "mass-destructive", label: "Mass destructive operations" },
  { id: "send-as-ash", label: "Messages sent as Ash" },
  { id: "credentials", label: "Credentials" },
];

export const RED_IDS: readonly RedCategory[] = RED_LIST.map((r) => r.id);

export function isRedCategory(value: unknown): value is RedCategory {
  return typeof value === "string" && (RED_IDS as readonly string[]).includes(value);
}

export function redLabel(id: RedCategory): string {
  return forUser(RED_LIST.find((r) => r.id === id)?.label ?? id);
}

// Each pattern is matched against the whole call, lower-cased (so flags read lower-case: -r, -d), with whitespace
// collapsed.
const PATTERNS: Record<RedCategory, readonly RegExp[]> = {
  money: [
    /\brefund(s|ed|ing)?\b/,
    /\bcharge ?backs?\b/,
    /\bcharg(e|es|ed|ing) (the |a |an |their |his |her |every |each |all )?(customer|user|client|buyer|account|card|subscriber)s?\b/,
    /\b(re)?charg(e|ing) (them|him|her)\b/,
    /\bpayouts?\b/,
    /\bwire (transfer|money|funds)\b/,
    /\b(send|move|transfer|withdraw|deposit|pay|bridge|swap)(s|ed|ing)? (the |some |all |their |his |her )?(money|funds|usdc|eth|btc|crypto|\$\s?\d)/,
    /\bwithdraw(al|als|ing)?\b.{0,30}\b(wallet|funds|account|balance|usdc)\b/,
    /\b(issue|grant|apply|give) (a |an )?(credit|discount|coupon|comp|free month)s?\b.{0,30}\b(customer|user|account|subscription)/,
    /\bstripe\b.{0,40}\b(refund|charge|payout|transfer|invoice|subscription|coupon|credit|price)/,
    /\b(cancel|upgrade|downgrade|change) (their|the customer'?s?|a user'?s?|his|her) (plan|subscription|billing)\b/,
    /\b(top[- ]?up|credit) (their|the|a) (balance|account|wallet)\b/,
    /\bmove money\b/,
  ],
  delete: [
    /\brm\s+(-[a-z]*r[a-z]*|--recursive)\b/,
    /\brm\s+-[a-z]*f[a-z]*\s+\S*[*~]/,
    /\bfind\b.{0,80}\s-delete\b/,
    /\bdrop\s+(table|database|schema|index|column)\b/,
    /\btruncate\s+(table\s+)?\w/,
    /\bdelete\s+from\b/,
    /\b(delete|deleting|deleted|drop|dropping|wipe|wiping|purge|purging|erase|erasing|destroy|destroying|nuke|nuking)\b.{0,40}\b(data|database|databases|db|dbs|tables?|records?|rows?|users?|accounts?|customers?|buckets?|backups?|snapshots?|volumes?|disks?|vms?|instances?|servers?|history|chats?|conversations?|transcripts?|memor(y|ies)|emails?|inbox|messages|worktrees?|data ?folder|storage|uploads?|logs)\b/,
    /\b(remove|removing|clear|clearing|reset|resetting)\b.{0,30}\b(database|databases|db|backups?|snapshots?|volumes?|vms?|instances?|servers?|accounts?|customers?|data ?folder|buckets?|storage|production data|user data|customer data|live data)\b/,
    /\bgit\s+clean\s+-[a-z]*f|\bgit\s+branch\s+-[a-z]*d|\bgit\s+worktree\s+remove\b|\bgit\s+stash\s+(drop|clear)\b|\bgit\s+reflog\s+expire\b/,
    /\bsqlite3?\b.{0,80}\b(delete|drop|truncate)\b/,
    /\b(supabase|psql|mysql|mongo)\b.{0,80}\b(delete|drop|truncate|reset)\b/,
  ],
  "prod-host": [
    /\bprod(uction)?\b.{0,40}\b(host|server|box|boxes|vm|vms|machine|node|cluster|db|database|deploy|deployment|maintenance|restart|reboot|migration|migrate|promote|rollout|roll out|upgrade|patch|failover|dns|caddy|nginx|firewall)\b/,
    /\b(host|server|vm|database|db|deploy|deployment|maintenance|restart|reboot|migration|promote|rollout|upgrade)\b.{0,30}\b(on|in|to) prod(uction)?\b/,
    /\b(ssh|scp|rsync|mosh)\b.{0,80}\b(prod|production|root@|pve\d*|proxmox|hetzner)/,
    /\b(proxmox|pve\d+|hetzner|qm (stop|start|destroy|reboot|set|migrate)|pct (stop|destroy|reboot))\b/,
    /\b(sudo\s+)?(reboot|poweroff)\b|\bshutdown\s+-[hr]\b/,
    /\bsystemctl\s+(restart|stop|disable|reboot|poweroff)\b/,
    /\bvercel\b.{0,40}(--prod\b|\bpromote\b|\brollback\b)/,
    /\b(fly|flyctl|heroku|railway|render)\b.{0,40}\b(deploy|scale|restart|destroy)\b/,
    /\bmigrat(e|ion|ions)\b.{0,40}\b(prod|production|moltbot|live database|live db)\b/,
    /\bpromote (it |this |the build |canary )?to (prod|production|main)\b/,
  ],
  "mass-destructive": [
    /\b(all|every|each|mass|bulk|batch of)\b.{0,30}\b(delete|deleting|remove|removing|cancel|cancelling|canceling|close|closing|archive|archiving|revoke|revoking|kill|killing|drop|dropping|wipe|wiping|suspend|suspending|terminate|terminating|ban|banning|refund)\b/,
    /\b(delete|remove|cancel|close|archive|revoke|kill|drop|wipe|suspend|terminate|ban)\b.{0,20}\b(all|every|each)\b/,
    /\bgit\s+push\b.{0,40}(--force\b|-f\b|--force-with-lease\b|\+\w)/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/,
    /\b(pkill|killall)\b/,
    /\bkill\s+-9\b/,
    /\bdocker\s+(system|volume|image|container)\s+prune\b/,
    /\bkubectl\s+delete\b/,
    /\bterraform\s+(destroy|apply\s+-destroy)\b/,
    /\b(chmod|chown)\s+-r\b/,
    /\bxargs\b.{0,40}\brm\b/,
  ],
  "send-as-ash": [
    /\b(send|sending|post|posting|publish|publishing|tweet|tweeting|announce|announcing|broadcast|broadcasting|email|emailing|dm|dming)\b.{0,50}\b(as (ash|me|him)|on (ash'?s|his|my) behalf|from (ash'?s|his|my) (account|email|address|handle)|customers?|users?|subscribers?|clients?|everyone|the team|the community|investors?|holders?|followers?|newsletter|mailing list|slack|discord|telegram|twitter|x\.com|linkedin|instagram|tiktok|reddit|whatsapp|imessage|gmail|resend)\b/,
    /\b(reply|replying|respond|responding)\b.{0,20}\bto (the |a |that |this |their |his |her )?(customer|client|email|tweet|dm|thread|comment|review)s?\b/,
    // Tool names (mcp__slack__chat_postMessage, gmail_send_message): underscores join words, so no \b here.
    /(gmail|slack|discord|telegram|twitter|resend|sendgrid|mailgun|postmark|whatsapp|imessage)[\w .-]{0,24}?(send|post|reply|message|broadcast)/,
    /(^|[^a-z.])(send|post)_?(message|email|mail|tweet|dm|reply)/,
    /\bgh\s+(issue|pr)\s+(comment|review|close)\b/,
    /\bgh\s+api\b.{0,60}\bcomments?\b/,
    /\bosascript\b.{0,80}\b(messages|mail)\b/,
    /\b(customer|subscriber|holder)s? (notice|announcement|newsletter|broadcast|email blast)\b/,
  ],
  credentials: [
    /\b(api|secret|access|private|signing|service[- ]role|anon) ?keys?\b/,
    /\b(client|webhook|jwt|app) secrets?\b/,
    /\bpass(word|words|phrase|code)s?\b/,
    /\bcredentials?\b/,
    /\b(access|auth|bearer|refresh|session|github|gh|npm|pat|oauth|personal access) tokens?\b/,
    /\bssh[- ]?keys?\b|\bid_(rsa|ed25519)\b|\.pem\b/,
    /\bkeychain(s)?\b|\bsecurity\s+(find|add|delete)-(generic|internet)-password\b/,
    // WP-101: a file that holds a login, whatever command reads it (cat, find, stat, file, du, ls).
    /\.netrc\b|\.pgpass\b|\.pypirc\b|\.npmrc\b/,
    /\.gnupg\b|\.ssh\b|\.docker[\/]config\.json|\.kube[\/]config\b|\.aws[\/]credentials\b/,
    /(^|[\s/])\.config[\/]gh\b|gh[\/]hosts\.yml\b/,
    /\bseed phrase\b|\bmnemonic\b|\bwallet (key|seed)\b/,
    /(^|[\s/'"`])\.env(\.[a-z]+)?\b/,
    /\b(2fa|mfa|otp|one[- ]time (code|password)|recovery codes?)\b/,
    /\b(rotate|revoke|regenerate|share|print|paste|leak)\b.{0,30}\b(keys|secret|secrets|token|tokens|credential|credentials)\b/,
  ],
};

/** The text a call is judged on: everything it says, joined. */
export function callText(...parts: (string | undefined | null)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" \n ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The first red-list category the text touches, in the list's order, or null. */
export function redListCategory(text: string): RedCategory | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  for (const { id } of RED_LIST) {
    if (PATTERNS[id].some((pattern) => pattern.test(normalized))) return id;
    // WP-101 fix round 2, item B: a path is checked segment by segment against the places and names a login lives
    // under, which no fixed pattern can list.
    if (id === "credentials" && credentialInText(normalized)) return id;
  }
  return null;
}

/**
 * The first red-list category the words of a command touch, or null. A command is judged on the words the shell would
 * pass (shellWords.ts), so a quoted path reads as the path it is: `cat ~/.ne"t"rc` names the netrc, and
 * `cat ~/.s''sh/config` names the ssh config. `folder` is the chat's folder: a relative path that climbs out of it is
 * resolved against it, so `cat ../../.zshrc` reads as the home file it is.
 */
export function redListInWords(words: readonly string[], folder?: string): RedCategory | null {
  if (credentialInWords(words, folder)) return "credentials";
  return redListCategory(words.join(" "));
}

/**
 * The red-list verdict for a call: the agent's own mark, else what the text says. An agent can make a call red; it can
 * never make a red call plain ("red":"none" is ignored when the text says otherwise).
 */
export function redVerdict(text: string, declared?: unknown): RedCategory | null {
  if (isRedCategory(declared)) return declared;
  return redListCategory(text);
}
