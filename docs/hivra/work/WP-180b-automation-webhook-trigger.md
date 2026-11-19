# WP-180b: A webhook can start an automation

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | M | 180a | no |

From PLAN.md, "Ideas from kitze's factory teaser", item 1 (the webhook trigger). Ideas only, nothing credited.

## Goal

The person can give an automation a webhook address. A request to that address with the right secret starts one run,
and the run feed (WP-180a) says "Webhook received" with the run that followed. It is off until the person turns it
on, and it listens on this Mac only.

## What Hivra has

- `src-tauri/src/automations.rs`: `validate_trigger` accepts the kinds `time`, `github`, `linear`, `jira`, `gitlab`,
  `azuredevops`. Outside events reach an automation through `automations_claim_event` (`AutomationEventClaim`:
  `event_key`, `event_kind`, `event`, `prompt`), which already removes duplicates by `event_key`
  (`automation_event_claims` table).
- `src/features/automations/model/automationEvents.ts` matches polled Inbox items to triggers. Nothing listens for a
  push.
- The app already runs loopback listeners with care: `src-tauri/src/terminal_mirror.rs` (127.0.0.1 only, a failure to
  listen does not stop the app) and `page_http.rs`.
- Dev copies turn automations off (AGENTS.md, "Which copy is which").

## What to build

1. **A `webhook` trigger kind.** `validate_trigger` and the TypeScript `AutomationTriggerKind` gain `webhook`. The
   trigger holds a hook id. The secret is a random 32-byte value stored in the Keychain through `hub_keychain.rs`
   (dev copies use their own `monocode-hub-dev:*` names), never in the database, an export or a log.
2. **One listener, off by default.** A new module `src-tauri/src/automation_webhooks.rs` binds `127.0.0.1` on a port
   the person can see and change, only while Settings > Automations > "Accept webhooks" is on and at least one
   automation has a webhook trigger. It accepts `POST /hooks/<hook-id>` with the secret in a header or an HMAC-SHA256
   signature of the body (the GitHub `X-Hub-Signature-256` shape), compared in constant time. Anything else gets a
   plain 404 with no detail.
3. **Limits in code.** Body at most 256 KB; at most 10 requests a minute per hook, then 429; the body is kept for
   the run's prompt only after secrets are scrubbed (`portable::scrubber`) and cut to 8 KB. The event key is the
   request's delivery id header when present, else a hash of the body, so a retried delivery starts no second run.
4. **The run** goes through `automations_claim_event` like any other event, with `event_kind` `webhook`, and the
   activity line from WP-180a ("Webhook received for Nightly triage").
5. **The editor** shows the address, a copy button, "Show secret" (reads the Keychain once), "New secret" (the old one
   stops at once) and one plain sentence: "This address works on this Mac only. To reach it from outside, put your
   own tunnel in front of it."

## Rules

- Off by default, and refused in a dev copy and under a temporary HOME unless a test turns it on explicitly.
- Loopback only. No tunnel, relay, public port or router mapping is opened by the app.
- No new outward network call.
- A webhook can only start an automation the person already made and enabled. It cannot change the automation's
  prompt, folder, model or permission mode; the request body is passed as the event text, fenced as untrusted.
- Never weakens existing approvals or the protected-path list (`src/shared/security/agentConfigPaths.json`, when it
  exists): the run asks for what any automation run asks for.
- Upstream rules from PLAN.md: the new module, and one-line hooks in `lib.rs` and `automations.rs`.

## Done when

- [ ] Red first: a Rust test posts to a webhook with the setting off and gets no listener; then with it on, a right
      secret starts one run and a wrong one, a missing one and a bad signature each get 404 and start nothing.
- [ ] Tests: the same delivery id twice starts one run; the 11th request in a minute gets 429; a 300 KB body is
      refused; a key in the body is scrubbed from the prompt; "New secret" makes the old one fail.
- [ ] Test: the listener refuses to bind in a dev copy without the explicit test switch, and binds 127.0.0.1 only.
- [ ] Test: export and the diagnostics log carry no webhook secret (the existing final secret scan passes).
- [ ] Browser spec `tests/browser/automation-webhook.spec.ts`: the setting, the address and copy button, and a
      seeded "Webhook received" line in Runs. Screenshot in the PR.
- [ ] `npm run check` passes. A dev-copy check with `curl` against the loopback address is listed as open until done.

## Not in this package

Any way to reach the hook from outside the Mac. Webhooks on the remote host (WP-196a). Outgoing webhooks.
