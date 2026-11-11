# WP-115: Compact an idle Claude chat before its prompt cache expires, and say plainly when an agent cannot do something

| Wave | Size | Depends on | Grok OK |
| --- | --- | --- | --- |
| L | S | none | yes |

## Goal

Two small polish items, from the same T3 pass:

1. A large idle Claude chat is compacted about two minutes before its prompt cache expires, so the next turn does not pay to rebuild the full cache. Today's "compact on the next send, after the cache has already died" behaviour is the fallback, not the happy path.
2. When the current agent cannot do something the button would do (for example redirect a running turn), the person sees a plain sentence such as "Codex can't redirect a running turn. Stop it, then send." The button does not pretend it can.

## Why

Ash asked Hermes for the cheap, visible T3 details. Two that were listed as "build next" never got a package: idle compaction timed to the prompt cache, and capability sentences.

Hivra already has idle compaction (`idleCompactionDue` in `src/features/sessions/model/contextCeiling.ts`, used from `src/integrations/harness/providers/claude/claude.ts`, setting "Compact idle chats first"). It runs when the next message is sent and the chat has already been idle longer than the cache TTL, and only above 100K tokens. T3's version (idea only: `IdleCompaction.ts`, `IdleCompactionService.ts`) starts two minutes *before* the cache expires (about 1 hour on a subscription, 5 minutes on an API key) while the chat is idle, so the compacted context is what the cache holds. That is the gap.

T3 also turns a missing provider capability into a sentence, not a broken button (`UserFacingErrors.ts`, example: "Codex cannot redirect an active run. Stop it first, then send the message."). Hivra has queue and steer logic (`messageQueue.ts`) but no such plain capability copy showed up in a search. This package finds the real buttons and fixes those, it does not invent a new capability system.

T3 Code is MIT, "Copyright (c) 2026 T3 Tools Inc." Both items are ideas (and short strings) to rebuild, not files to copy.

## Read first

- Hivra: `contextCeiling.ts` and `contextCeiling.test.ts`, `claudePromptCache.ts`, `claude.ts` around idle compaction, `claudeLongChats.test.ts`, the "Compact idle chats first" setting in `settings.ts` and `SettingsView.tsx`. `messageQueue.ts`, steer/redirect/edit-last-turn UI, harness capability flags if any exist.
- Local read-only T3 notes, not part of this repo: the rip list's two "Build next" rows, and the deep-dive sections "Idle compaction" and "Capabilities, not names".
- Do not copy T3 source. The example sentence may be adapted; do not take the file.

## Build

A. **Idle compaction, two minutes early** (tests first).

1. Keep the existing setting and the 100K floor. Keep "off" as a way to disable it.
2. Change the due rule so a chat becomes due when it has been idle for `ttl - 2 minutes` (never earlier than a small floor if the TTL itself is under two minutes: then due at half the TTL, or skip proactive compact and keep today's on-send path; say which in PR.md). Subscription TTL stays about one hour, API-key TTL about five minutes, from the existing cache knowledge in `claudePromptCache.ts`; do not invent new TTLs if the adapter already stores one.
3. When a Claude chat is idle and due, compact it in the background. Do not compact a chat that is mid-turn, and do not compact because the person sent a new message (the current on-send path remains as a fallback if the cache already expired). Show one plain line in the chat, such as "Compacted this idle chat so the next message does not rebuild the whole prompt cache."
4. Compaction must not feel like a silent, irreversible loss of the working context: it uses the same compact path Claude already has, and the notice is visible. Do not auto-send anything.
5. Update `contextCeiling.test.ts` and `claudeLongChats.test.ts` for the new timing. A unit test must prove a chat one minute before expiry (above the floor) is due, and a chat two minutes before a one-hour TTL is not.

B. **Plain "can't do that" sentences** (tests first).

1. Find three real places where the UI offers steer, redirect, edit, fork, queue, or a similar action that some harnesses cannot do. Search before inventing a framework.
2. For each, if the current agent cannot do it, hide or disable the action and show one plain sentence that says what to do instead. Example shape: "Codex can't redirect a running turn. Stop it, then send."
3. If you cannot find three real places, do the ones you can and list the search in PR.md. Do not add dead strings.

## Copy with credit

Ideas and short user-facing sentences inspired by T3 need no credit unless you translate a T3 file (you should not).

## Done when

- [ ] A large idle Claude chat is compacted about two minutes before cache expiry, with a visible notice, and mid-turn chats are left alone.
- [ ] The previous on-send fallback still runs if the cache has already expired.
- [ ] Existing setting still turns the feature off.
- [ ] At least one real "can't do that" sentence is wired to a real button, with tests; ideally three.
- [ ] No em dashes or en dashes in any text a person sees.
