# B5 run 20261030-220202-deb4 (BLIND, rerun after the fix): INCOMPLETE, the app was never idle enough to quit

Built at bc577da3 (it includes fix 96873ba1 + d3c8ccc5). The harness grader said PARTIAL. Times are GMT (Europe/London).

- 22:02-22:03: Ash's four dump messages went to Tally lead. The hub worker finished its 8 screen fixes at about 22:30 and the preview was put up.
- The restart was refused at 22:47 with "1 chat(s) still running; Quit would ask in a Mac dialog". That chat was Chief of
  Staff's open button question ("Which of these should I unlock? [Fix waitlist DKIM / Refunds FAQ, you OK wording /
  Privacy page, you OK it / None of these]"). It counts as in flight (isInFlightSession: busy or waiting on input).
  Nothing was quit or killed, and no dialog was shown. The run's normal teardown closed the copy afterwards.
- So the quit, the reopen, "wat happened..." and the 3 shots did not happen in this run. The one rerun the brief
  allows is now used.

## The fix, seen live before the quit
- The Lead now repeats its open asks in each later reply: "Needs the user: the privacy page is legal copy, so it waits on
  you. / My pick: don't publish one until you supply the wording." appears at +538s and again at +1706s, after
  other news. In run 7b6d these lines had dropped off.
- Honest status at +1706s: "It is not in the live hub until you click Apply. / Not done: nobody looked at it in the
  window, and the rail badge also clears when a send is refused, which is not what you asked."
- All 34 asks were read back by project, and nothing was posted to X ("I am not posting any of it").

## Open (for Ash)
- A pending question card makes Quit ask in a Mac dialog. A real quit at that moment would ask Ash, by design
  ("an Inbox Ask still counts as work nobody agreed to throw away"). A B5 rerun needs either Ash answering that card
  first or his OK to quit through the dialog.
