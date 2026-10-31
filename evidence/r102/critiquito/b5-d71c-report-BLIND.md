# r102 B5 run 1, BLIND, base: 20261031-094457-d71c

- Scenario: b5-dump-restart-blind (Ash's plain style, 40 asks, quit + reopen, "wat happened to the stuff i dumped earlier").
- Engine: --grok-sub (Claude Code via claude-grok bridge, grok-4.7). No Claude subscription.
- Restart: the (6) wait worked. Quit was refused while a chat ran; the bench waited and quit at +1873s (10:16:30 GMT), reopened as pid 81591. Not blocked.
- Grade: B5 PARTIAL, CQ PARTIAL.
  - B5: "All 40 asks survived and the +1943s reply splits them as 17 done, 2 blocked and 21 parked ... nothing was posted ... That reply still says the inbox is empty while a Needs you is on screen, and kids mode is counted done with no worker report."
  - CQ: "sends a 40-item wall at +264s and then says nothing in the lead thread from +407s until +1811s."
- Status reply (count line first, 17+2+21=40, short groups):
  "Of 40: 17 done, 2 blocked by your answers, 21 parked. / Nothing is in your Inbox. / Done: 14 hub fixes ... / Blocked: the store-review reply and the hub launch thread ... / Parked: ..."
- Ledger: evidence/r102/b5-d71c-ledger.md (17 named only through their group, 0 lost by count).
- Rendered (stub, not live): r101-d71c-{inbox,rail,lead-chat}-RENDERED-from-run-not-live.png in this folder.
  - Usage chip reads "Weekly limit nearly used, resets in 5d 15h" with a grey bar (10 holds).
  - Found: the Lead's separate lines render as one paragraph (markdown soft breaks), and the stub still shows the starburst on the footer chip and an Older row (stub isn't on the bridge); fixed before run 3.
