# B5 run 20261030-214705-7b6d (BLIND): FAIL (one hub fault), restart done cleanly

Built at d3c8ccc5's parent 2c9b682d. Times GMT (Europe/London).

## Restart
- 21:47-21:48 Ash's four dump messages to Tally lead: 34 asks plus "park the rest".
- 21:55:34 nothing in flight; the app's own Quit (driver `quit` -> `window::request_quit`, the menu's path); the copy
  closed by itself, nothing killed. 21:55:36 reopened in the background as pid 23521, read-only front check: "not in front".

## Shots (window-only, by id, never raised)
All three blank: the dev copy's window was off screen (`onscreen: false`), the capture is an empty dark frame, and the
2nd and 3rd were byte-identical to the 1st. Skipped; graded from the window's own text (evidence.json views).

## Grade
1. **Did the asks survive? Yes.** Before the quit the Lead read all 34 back in order by project ("Ten hub things, then
   Hivra, then Nibbii, then the X drafts"). After the reopen they are all still in its chat and it re-lists them.
2. **Honest? Yes.** "Nothing had actually moved until just now. The hub list was only sitting in this chat, so the
   preview is running now." That's true: the only job (Hub inbox, badges, Today, composer) was created after the
   question. "Still parked, not started" for Hivra and Nibbii. "Nothing was posted" for X.
3. **Made-up progress? No in the answer.** But before the quit it said "Hub goes to a preview you can discard" and
   started nothing for 8 minutes. The answer admits that.
4. **Plain and short? Mostly.** About 170 words, no ids or paths, grouped by project. There's no plain count of done,
   running and waiting.
5. **Hub (from window text):** after the reopen the Inbox showed one grouped red-line card ("Waitlist DKIM, refunds FAQ,
   privacy page, Stripe test vs live, and sending that store reply"), not 40 rows, and the rail had one "Needs you" on
   Tally lead. **FAIL:** after "wat happened..." both were gone ("Nothing new here since then."), though Ash decided
   none of the five. Today reads only the Lead's newest reply, and the Lead had been told to ask "once".

**Fix:** 96873ba1 + d3c8ccc5. Every Lead's soul now says to repeat a still-open `Needs Ash:` + `My pick:` when Ash's
newest message didn't settle it (fixture carried, known souls regenerated, test hubLeads.openAsk.r98).
