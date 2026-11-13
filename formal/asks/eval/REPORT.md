# Ask extraction eval

Messages: 10. Labelled asks: 52, plus 3 asked and withdrawn in the same message. Corpus: formal/asks/eval/messages.json


### hub ledger extractor (askLedger.ts extractAsks: regex only, at most 6 per message; feeds the Chief's 'You asked' list)

Recall: **62%** of 52 asks are a row of their own (32); 9 only inside a row that also holds another ask; 0 only as a "maybe" line (with those: 62%); 11 missed.
Implicit asks as their own row: 4/7. Buried asks: 2/5. Kind agrees with the label: 21/32.
Noise: 1/3 withdrawn asks still open; 1 duplicate rows; 2 pasted sentences kept as asks; 7 other rows with no labelled ask behind them; 0 unlabelled "maybe" lines.

| Message | Asks | Own row | Merged | Maybe only | Missed | Rows kept | Withdrawn still open | Model tries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m01-polish-list | 6 | 5 | 0 | 0 | 1 | 5 | 0 | none |
| m02-mobile-build | 5 | 3 | 0 | 0 | 2 | 6 | 0 | none |
| m03-complaints | 5 | 3 | 0 | 0 | 2 | 4 | 0 | none |
| m04-run-on | 7 | 0 | 6 | 0 | 1 | 1 | 0 | none |
| m05-releases | 6 | 5 | 0 | 0 | 1 | 6 | 0 | none |
| m06-change-of-plan | 4 | 4 | 0 | 0 | 0 | 6 | 1 | none |
| m07-pasted-customer | 4 | 3 | 0 | 0 | 1 | 6 | 0 | none |
| m08-dictation | 3 | 0 | 3 | 0 | 0 | 1 | 0 | none |
| m09-call-notes | 6 | 5 | 0 | 0 | 1 | 5 | 0 | none |
| m10-week-notes | 6 | 4 | 0 | 0 | 2 | 5 | 0 | none |

Not an own row:
- m01-polish-list a3 (missed, implicit): the settings page says 'Preferances' with a typo
- m02-mobile-build a5 (missed): can we get a nightly build going
- m02-mobile-build a6 (missed): tell me roughly what that costs
- m03-complaints a2 (missed, implicit): why the dashboard shows yesterday's numbers in the morning
- m03-complaints a3 (missed): It would be great if the export remembered my last folder
- m04-run-on a1 (merged): we need the billing page to show the VAT number
- m04-run-on a2 (merged): the receipt PDF has to use the company logo not the old one
- m04-run-on a3 (merged): look at why the refund button does nothing on Safari
- m04-run-on a4 (merged): I want an email to go to finance when a refund is over five hundred
- m04-run-on a5 (merged): make sure the audit log keeps who clicked it
- m04-run-on a6 (merged, buried): rename Refund to Reverse payment everywhere in the UI
- m04-run-on a7 (missed, buried): letting customers download all their invoices as one zip
- m05-releases a2 (missed): post them to the changelog page automatically
- m07-pasted-customer a4 (missed): write me a short summary of what happened that I can forward to her account manager
- m08-dictation a1 (merged): get the thing working where when I tap the bell icon it shows the notifications
- m08-dictation a2 (merged, implicit): the unread count is wrong it says nine when there are two
- m08-dictation a3 (merged, buried): we should just remove the sound for now
- m09-call-notes a5 (missed): find out what that would take and tell me
- m10-week-notes a1 (missed): backup job: it failed twice, find out why
- m10-week-notes a5 (missed): ask Theo if the staging box is still needed

Noise:
- m02-mobile-build 1 duplicate row(s)
- m02-mobile-build unlabelled row: Example: Right so about the mobile build.
- m02-mobile-build unlabelled row: Did I mention the Android build is failing?
- m03-complaints unlabelled row: Like really slow, I typed my own name in and went and made tea.
- m05-releases unlabelled row: Every Friday I end up tagging the build, writing the notes and posting in the channel, and
- m06-change-of-plan withdrawn but open: Make the funnel chart colours match the brand palette
- m06-change-of-plan unlabelled row: Example: Change of plan on the dashboard.
- m07-pasted-customer pasted sentence kept as ask: Please fix this before month end
- m07-pasted-customer pasted sentence kept as ask: Can you tell us when it will be done
- m07-pasted-customer unlabelled row: Example: Dana from Kestrel Foods wrote in and I want us to handle it properly.
- m10-week-notes unlabelled row: I want to know before it does.

### rules only (no model call: what the app keeps when no engine can answer)

Recall: **33%** of 52 asks are a row of their own (17); 8 only inside a row that also holds another ask; 0 only as a "maybe" line (with those: 33%); 27 missed.
Implicit asks as their own row: 0/7. Buried asks: 1/5. Kind agrees with the label: 14/17.
Noise: 1/3 withdrawn asks still open; 0 duplicate rows; 2 pasted sentences kept as asks; 3 other rows with no labelled ask behind them; 0 unlabelled "maybe" lines.

| Message | Asks | Own row | Merged | Maybe only | Missed | Rows kept | Withdrawn still open | Model tries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m01-polish-list | 6 | 3 | 0 | 0 | 3 | 3 | 0 | none |
| m02-mobile-build | 5 | 4 | 0 | 0 | 1 | 5 | 0 | none |
| m03-complaints | 5 | 0 | 0 | 0 | 5 | 0 | 0 | none |
| m04-run-on | 7 | 0 | 5 | 0 | 2 | 1 | 0 | none |
| m05-releases | 6 | 2 | 0 | 0 | 4 | 2 | 0 | none |
| m06-change-of-plan | 4 | 2 | 0 | 0 | 2 | 3 | 1 | none |
| m07-pasted-customer | 4 | 3 | 0 | 0 | 1 | 6 | 0 | none |
| m08-dictation | 3 | 0 | 3 | 0 | 0 | 1 | 0 | none |
| m09-call-notes | 6 | 1 | 0 | 0 | 5 | 1 | 0 | none |
| m10-week-notes | 6 | 2 | 0 | 0 | 4 | 3 | 0 | none |

Not an own row:
- m01-polish-list a2 (missed): make it only show once per install
- m01-polish-list a3 (missed, implicit): the settings page says 'Preferances' with a typo
- m01-polish-list a6 (missed): tell me which of these you think is the riskiest
- m02-mobile-build a3 (missed): leave the iOS version alone
- m03-complaints a1 (missed, implicit): the search is slow
- m03-complaints a2 (missed, implicit): why the dashboard shows yesterday's numbers in the morning
- m03-complaints a3 (missed): It would be great if the export remembered my last folder
- m03-complaints a4 (missed, implicit): the dark theme is too bright in the sidebar
- m03-complaints a5 (missed, implicit): we're missing a way to undo a delete
- m04-run-on a1 (merged): we need the billing page to show the VAT number
- m04-run-on a2 (merged): the receipt PDF has to use the company logo not the old one
- m04-run-on a3 (merged): look at why the refund button does nothing on Safari
- m04-run-on a4 (merged): I want an email to go to finance when a refund is over five hundred
- m04-run-on a5 (merged): make sure the audit log keeps who clicked it
- m04-run-on a6 (missed, buried): rename Refund to Reverse payment everywhere in the UI
- m04-run-on a7 (missed, buried): letting customers download all their invoices as one zip
- m05-releases a2 (missed): post them to the changelog page automatically
- m05-releases a3 (missed): The tagging should happen when I say 'ship it' in chat and not before
- m05-releases a4 (missed): the channel post should tag whoever is on call
- m05-releases a5 (missed): always run the full checks before any tag
- m06-change-of-plan a4 (missed): remind me on Thursday to review the draft, make it recurring
- m06-change-of-plan a5 (missed): what's the actual difference between a Page and a hub in this app
- m07-pasted-customer a2 (missed): look into the export timeouts
- m08-dictation a1 (merged): get the thing working where when I tap the bell icon it shows the notifications
- m08-dictation a2 (merged, implicit): the unread count is wrong it says nine when there are two
- m08-dictation a3 (merged, buried): we should just remove the sound for now
- m09-call-notes a1 (missed): We're going with Postgres, not SQLite, for the team plan
- m09-call-notes a2 (missed): put the ticket number at the start of every commit message
- m09-call-notes a4 (missed, implicit): Do the same fix on the other page, you know the one, the one with the long table
- m09-call-notes a5 (missed): find out what that would take and tell me
- m09-call-notes a6 (missed, buried): tidy up the old branches
- m10-week-notes a1 (missed): backup job: it failed twice, find out why
- m10-week-notes a2 (missed): add a retry to the nightly sync
- m10-week-notes a3 (missed): the empty state on the Needs screen is dull, give it something to say
- m10-week-notes a5 (missed): ask Theo if the staging box is still needed

Noise:
- m02-mobile-build unlabelled row: Did I mention the Android build is failing?
- m06-change-of-plan withdrawn but open: Make the funnel chart colours match the brand palette
- m07-pasted-customer pasted sentence kept as ask: Please fix this before month end
- m07-pasted-customer pasted sentence kept as ask: Can you tell us when it will be done
- m07-pasted-customer unlabelled row: Example: Dana from Kestrel Foods wrote in and I want us to handle it properly.
- m10-week-notes unlabelled row: I want to know before it does.

### oracle (a model that returns exactly the labelled asks: the ceiling the pipeline allows)

Recall: **100%** of 52 asks are a row of their own (52); 0 only inside a row that also holds another ask; 0 only as a "maybe" line (with those: 100%); 0 missed.
Implicit asks as their own row: 7/7. Buried asks: 5/5. Kind agrees with the label: 52/52.
Noise: 0/3 withdrawn asks still open; 0 duplicate rows; 0 pasted sentences kept as asks; 0 other rows with no labelled ask behind them; 3 unlabelled "maybe" lines.
Model: failed on every try for 0 of 10 messages (the rules' reading stands there).

| Message | Asks | Own row | Merged | Maybe only | Missed | Rows kept | Withdrawn still open | Model tries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m01-polish-list | 6 | 6 | 0 | 0 | 0 | 6 | 0 | ok |
| m02-mobile-build | 5 | 5 | 0 | 0 | 0 | 6 | 0 | ok |
| m03-complaints | 5 | 5 | 0 | 0 | 0 | 5 | 0 | ok |
| m04-run-on | 7 | 7 | 0 | 0 | 0 | 7 | 0 | ok |
| m05-releases | 6 | 6 | 0 | 0 | 0 | 6 | 0 | ok |
| m06-change-of-plan | 4 | 4 | 0 | 0 | 0 | 5 | 0 | ok |
| m07-pasted-customer | 4 | 4 | 0 | 0 | 0 | 7 | 0 | ok |
| m08-dictation | 3 | 3 | 0 | 0 | 0 | 3 | 0 | ok |
| m09-call-notes | 6 | 6 | 0 | 0 | 0 | 6 | 0 | ok |
| m10-week-notes | 6 | 6 | 0 | 0 | 0 | 7 | 0 | ok |

Every ask is an own row.

Noise:
- m07-pasted-customer pasted sentence kept as maybe: Please fix this before month end
- m07-pasted-customer pasted sentence kept as maybe: Can you tell us when it will be done

### recorded replies (SIMULATED, not captured from the app's engine. Hand-written ...)

Recall: **92%** of 52 asks are a row of their own (48); 0 only inside a row that also holds another ask; 0 only as a "maybe" line (with those: 92%); 4 missed.
Implicit asks as their own row: 4/7. Buried asks: 5/5. Kind agrees with the label: 48/48.
Noise: 3/3 withdrawn asks still open; 1 duplicate rows; 0 pasted sentences kept as asks; 0 other rows with no labelled ask behind them; 3 unlabelled "maybe" lines.
Model: failed on every try for 0 of 10 messages (the rules' reading stands there).

| Message | Asks | Own row | Merged | Maybe only | Missed | Rows kept | Withdrawn still open | Model tries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m01-polish-list | 6 | 5 | 0 | 0 | 1 | 5 | 0 | ok |
| m02-mobile-build | 5 | 4 | 0 | 0 | 1 | 7 | 1 | ok |
| m03-complaints | 5 | 4 | 0 | 0 | 1 | 4 | 0 | ok |
| m04-run-on | 7 | 7 | 0 | 0 | 0 | 7 | 0 | ok |
| m05-releases | 6 | 6 | 0 | 0 | 0 | 6 | 0 | ok |
| m06-change-of-plan | 4 | 4 | 0 | 0 | 0 | 5 | 1 | ok |
| m07-pasted-customer | 4 | 4 | 0 | 0 | 0 | 7 | 0 | ok |
| m08-dictation | 3 | 3 | 0 | 0 | 0 | 3 | 0 | ok |
| m09-call-notes | 6 | 5 | 0 | 0 | 1 | 5 | 0 | ok |
| m10-week-notes | 6 | 6 | 0 | 0 | 0 | 8 | 1 | ok |

Not an own row:
- m01-polish-list a3 (missed, implicit): the settings page says 'Preferances' with a typo
- m02-mobile-build a3 (missed): leave the iOS version alone
- m03-complaints a5 (missed, implicit): we're missing a way to undo a delete
- m09-call-notes a4 (missed, implicit): Do the same fix on the other page, you know the one, the one with the long table

Noise:
- m02-mobile-build withdrawn but open: bump the minimum iOS version to 16
- m02-mobile-build 1 duplicate row(s)
- m06-change-of-plan withdrawn but open: Make the funnel chart colours match the brand palette
- m07-pasted-customer pasted sentence kept as maybe: Please fix this before month end
- m07-pasted-customer pasted sentence kept as maybe: Can you tell us when it will be done
- m10-week-notes withdrawn but open: docs for the new import flow

### recorded replies (SIMULATED, not captured from the app's engine. Hand-written ...); model answers only its first 2 item(s)

Recall: **35%** of 52 asks are a row of their own (18); 0 only inside a row that also holds another ask; 12 only as a "maybe" line (with those: 58%); 22 missed.
Implicit asks as their own row: 3/7. Buried asks: 0/5. Kind agrees with the label: 18/18.
Noise: 2/3 withdrawn asks still open; 0 duplicate rows; 0 pasted sentences kept as asks; 0 other rows with no labelled ask behind them; 3 unlabelled "maybe" lines.
Model: failed on every try for 0 of 10 messages (the rules' reading stands there).

| Message | Asks | Own row | Merged | Maybe only | Missed | Rows kept | Withdrawn still open | Model tries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m01-polish-list | 6 | 2 | 0 | 2 | 2 | 4 | 0 | ok |
| m02-mobile-build | 5 | 1 | 0 | 3 | 1 | 6 | 1 | ok |
| m03-complaints | 5 | 2 | 0 | 0 | 3 | 2 | 0 | ok |
| m04-run-on | 7 | 2 | 0 | 0 | 5 | 2 | 0 | ok |
| m05-releases | 6 | 2 | 0 | 1 | 3 | 3 | 0 | ok |
| m06-change-of-plan | 4 | 1 | 0 | 1 | 2 | 3 | 1 | ok |
| m07-pasted-customer | 4 | 2 | 0 | 2 | 0 | 7 | 0 | ok |
| m08-dictation | 3 | 2 | 0 | 0 | 1 | 2 | 0 | ok |
| m09-call-notes | 6 | 2 | 0 | 1 | 3 | 3 | 0 | ok |
| m10-week-notes | 6 | 2 | 0 | 2 | 2 | 5 | 0 | ok |

Not an own row:
- m01-polish-list a3 (missed, implicit): the settings page says 'Preferances' with a typo
- m01-polish-list a4 (maybe, buried): I want it to go out Monday at 8 instead of Sunday night
- m01-polish-list a5 (maybe): please don't touch the pricing page
- m01-polish-list a6 (missed): tell me which of these you think is the riskiest
- m02-mobile-build a3 (missed): leave the iOS version alone
- m02-mobile-build a4 (maybe): Swap it for the new one in the brand folder please
- m02-mobile-build a5 (maybe): can we get a nightly build going
- m02-mobile-build a6 (maybe): tell me roughly what that costs
- m03-complaints a3 (missed): It would be great if the export remembered my last folder
- m03-complaints a4 (missed, implicit): the dark theme is too bright in the sidebar
- m03-complaints a5 (missed, implicit): we're missing a way to undo a delete
- m04-run-on a3 (missed): look at why the refund button does nothing on Safari
- m04-run-on a4 (missed): I want an email to go to finance when a refund is over five hundred
- m04-run-on a5 (missed): make sure the audit log keeps who clicked it
- m04-run-on a6 (missed, buried): rename Refund to Reverse payment everywhere in the UI
- m04-run-on a7 (missed, buried): letting customers download all their invoices as one zip
- m05-releases a3 (missed): The tagging should happen when I say 'ship it' in chat and not before
- m05-releases a4 (missed): the channel post should tag whoever is on call
- m05-releases a5 (missed): always run the full checks before any tag
- m05-releases a6 (maybe): tell me what you'd need from me to set up the on-call tagging
- m06-change-of-plan a3 (maybe): set up the weekly digest email to include the top five pages by views
- m06-change-of-plan a4 (missed): remind me on Thursday to review the draft, make it recurring
- m06-change-of-plan a5 (missed): what's the actual difference between a Page and a hub in this app
- m07-pasted-customer a3 (maybe): check whether any other big accounts have hit it
- m07-pasted-customer a4 (maybe): write me a short summary of what happened that I can forward to her account manager
- m08-dictation a3 (missed, buried): we should just remove the sound for now
- m09-call-notes a3 (maybe): What's the status of the migration script, is it ready or not
- m09-call-notes a4 (missed, implicit): Do the same fix on the other page, you know the one, the one with the long table
- m09-call-notes a5 (missed): find out what that would take and tell me
- m09-call-notes a6 (missed, buried): tidy up the old branches
- m10-week-notes a3 (missed): the empty state on the Needs screen is dull, give it something to say
- m10-week-notes a4 (maybe): can we show how long each job has been running
- m10-week-notes a5 (missed): ask Theo if the staging box is still needed
- m10-week-notes a7 (maybe): did the thing with the certificate expire yet

Noise:
- m02-mobile-build withdrawn but open: bump the minimum iOS version to 16
- m06-change-of-plan withdrawn but open: Make the funnel chart colours match the brand palette
- m07-pasted-customer pasted sentence kept as maybe: Please fix this before month end
- m07-pasted-customer pasted sentence kept as maybe: Can you tell us when it will be done

### recorded replies (SIMULATED, not captured from the app's engine. Hand-written ...); first 1 call(s) per message time out

Recall: **92%** of 52 asks are a row of their own (48); 0 only inside a row that also holds another ask; 0 only as a "maybe" line (with those: 92%); 4 missed.
Implicit asks as their own row: 4/7. Buried asks: 5/5. Kind agrees with the label: 48/48.
Noise: 3/3 withdrawn asks still open; 1 duplicate rows; 0 pasted sentences kept as asks; 0 other rows with no labelled ask behind them; 3 unlabelled "maybe" lines.
Model: failed on every try for 0 of 10 messages (the rules' reading stands there).

| Message | Asks | Own row | Merged | Maybe only | Missed | Rows kept | Withdrawn still open | Model tries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m01-polish-list | 6 | 5 | 0 | 0 | 1 | 5 | 0 | error > ok |
| m02-mobile-build | 5 | 4 | 0 | 0 | 1 | 7 | 1 | error > ok |
| m03-complaints | 5 | 4 | 0 | 0 | 1 | 4 | 0 | error > ok |
| m04-run-on | 7 | 7 | 0 | 0 | 0 | 7 | 0 | error > ok |
| m05-releases | 6 | 6 | 0 | 0 | 0 | 6 | 0 | error > ok |
| m06-change-of-plan | 4 | 4 | 0 | 0 | 0 | 5 | 1 | error > ok |
| m07-pasted-customer | 4 | 4 | 0 | 0 | 0 | 7 | 0 | error > ok |
| m08-dictation | 3 | 3 | 0 | 0 | 0 | 3 | 0 | error > ok |
| m09-call-notes | 6 | 5 | 0 | 0 | 1 | 5 | 0 | error > ok |
| m10-week-notes | 6 | 6 | 0 | 0 | 0 | 8 | 1 | error > ok |

Not an own row:
- m01-polish-list a3 (missed, implicit): the settings page says 'Preferances' with a typo
- m02-mobile-build a3 (missed): leave the iOS version alone
- m03-complaints a5 (missed, implicit): we're missing a way to undo a delete
- m09-call-notes a4 (missed, implicit): Do the same fix on the other page, you know the one, the one with the long table

Noise:
- m02-mobile-build withdrawn but open: bump the minimum iOS version to 16
- m02-mobile-build 1 duplicate row(s)
- m06-change-of-plan withdrawn but open: Make the funnel chart colours match the brand palette
- m07-pasted-customer pasted sentence kept as maybe: Please fix this before month end
- m07-pasted-customer pasted sentence kept as maybe: Can you tell us when it will be done
- m10-week-notes withdrawn but open: docs for the new import flow

### recorded replies (SIMULATED, not captured from the app's engine. Hand-written ...); first 2 call(s) per message time out

Recall: **33%** of 52 asks are a row of their own (17); 8 only inside a row that also holds another ask; 0 only as a "maybe" line (with those: 33%); 27 missed.
Implicit asks as their own row: 0/7. Buried asks: 1/5. Kind agrees with the label: 14/17.
Noise: 1/3 withdrawn asks still open; 0 duplicate rows; 2 pasted sentences kept as asks; 3 other rows with no labelled ask behind them; 0 unlabelled "maybe" lines.
Model: failed on every try for 10 of 10 messages (the rules' reading stands there).

| Message | Asks | Own row | Merged | Maybe only | Missed | Rows kept | Withdrawn still open | Model tries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m01-polish-list | 6 | 3 | 0 | 0 | 3 | 3 | 0 | error > error |
| m02-mobile-build | 5 | 4 | 0 | 0 | 1 | 5 | 0 | error > error |
| m03-complaints | 5 | 0 | 0 | 0 | 5 | 0 | 0 | error > error |
| m04-run-on | 7 | 0 | 5 | 0 | 2 | 1 | 0 | error > error |
| m05-releases | 6 | 2 | 0 | 0 | 4 | 2 | 0 | error > error |
| m06-change-of-plan | 4 | 2 | 0 | 0 | 2 | 3 | 1 | error > error |
| m07-pasted-customer | 4 | 3 | 0 | 0 | 1 | 6 | 0 | error > error |
| m08-dictation | 3 | 0 | 3 | 0 | 0 | 1 | 0 | error > error |
| m09-call-notes | 6 | 1 | 0 | 0 | 5 | 1 | 0 | error > error |
| m10-week-notes | 6 | 2 | 0 | 0 | 4 | 3 | 0 | error > error |

Not an own row:
- m01-polish-list a2 (missed): make it only show once per install
- m01-polish-list a3 (missed, implicit): the settings page says 'Preferances' with a typo
- m01-polish-list a6 (missed): tell me which of these you think is the riskiest
- m02-mobile-build a3 (missed): leave the iOS version alone
- m03-complaints a1 (missed, implicit): the search is slow
- m03-complaints a2 (missed, implicit): why the dashboard shows yesterday's numbers in the morning
- m03-complaints a3 (missed): It would be great if the export remembered my last folder
- m03-complaints a4 (missed, implicit): the dark theme is too bright in the sidebar
- m03-complaints a5 (missed, implicit): we're missing a way to undo a delete
- m04-run-on a1 (merged): we need the billing page to show the VAT number
- m04-run-on a2 (merged): the receipt PDF has to use the company logo not the old one
- m04-run-on a3 (merged): look at why the refund button does nothing on Safari
- m04-run-on a4 (merged): I want an email to go to finance when a refund is over five hundred
- m04-run-on a5 (merged): make sure the audit log keeps who clicked it
- m04-run-on a6 (missed, buried): rename Refund to Reverse payment everywhere in the UI
- m04-run-on a7 (missed, buried): letting customers download all their invoices as one zip
- m05-releases a2 (missed): post them to the changelog page automatically
- m05-releases a3 (missed): The tagging should happen when I say 'ship it' in chat and not before
- m05-releases a4 (missed): the channel post should tag whoever is on call
- m05-releases a5 (missed): always run the full checks before any tag
- m06-change-of-plan a4 (missed): remind me on Thursday to review the draft, make it recurring
- m06-change-of-plan a5 (missed): what's the actual difference between a Page and a hub in this app
- m07-pasted-customer a2 (missed): look into the export timeouts
- m08-dictation a1 (merged): get the thing working where when I tap the bell icon it shows the notifications
- m08-dictation a2 (merged, implicit): the unread count is wrong it says nine when there are two
- m08-dictation a3 (merged, buried): we should just remove the sound for now
- m09-call-notes a1 (missed): We're going with Postgres, not SQLite, for the team plan
- m09-call-notes a2 (missed): put the ticket number at the start of every commit message
- m09-call-notes a4 (missed, implicit): Do the same fix on the other page, you know the one, the one with the long table
- m09-call-notes a5 (missed): find out what that would take and tell me
- m09-call-notes a6 (missed, buried): tidy up the old branches
- m10-week-notes a1 (missed): backup job: it failed twice, find out why
- m10-week-notes a2 (missed): add a retry to the nightly sync
- m10-week-notes a3 (missed): the empty state on the Needs screen is dull, give it something to say
- m10-week-notes a5 (missed): ask Theo if the staging box is still needed

Noise:
- m02-mobile-build unlabelled row: Did I mention the Android build is failing?
- m06-change-of-plan withdrawn but open: Make the funnel chart colours match the brand palette
- m07-pasted-customer pasted sentence kept as ask: Please fix this before month end
- m07-pasted-customer pasted sentence kept as ask: Can you tell us when it will be done
- m07-pasted-customer unlabelled row: Example: Dana from Kestrel Foods wrote in and I want us to handle it properly.
- m10-week-notes unlabelled row: I want to know before it does.
