// The life of an ask, from Ash's message to done, dropped or in front of him: a Quint model of what the code does today.
// Read formal/asks/README.md first (the map of the real code this follows, and what is and is not modelled).
//
//   npx @informalsystems/quint typecheck formal/asks/asks.qnt
//   npx @informalsystems/quint run --max-samples 20000 --invariant inv_touchedNeverGone formal/asks/asks.qnt
//   npx @informalsystems/quint verify --invariant inv_touchedNeverGone formal/asks/asks.qnt      (needs Apalache and Java)
//
// Three actors act on one ledger: the PERSON (Ash: taps, adds an ask by hand, closes or resets a chat), the MATE (the
// first mate, and through it its crew: it marks an ask started, done or waiting, and delegates), and the APP (the
// extractor, the turn-end nudge, the daily check, a restart, a tidy). One message of Ash's holds three asks, slots 1 to
// 3. Both extractors miss slot 3 (an implicit ask), so it can only come from Ash's hand.
//
// The ledger rows follow src/features/asks/model/asks.ts: statuses heard, maybe, started, waiting, done, dropped. A row
// "gone" is one that was on the ledger and is not any more: the state that must never be reached.
//
// The knobs below say how the real code behaves TODAY (as committed). Turning one to its other value gives the design
// the spec (docs/specs/mono-chat-memory.md section 6) promises, or a deliberately broken variant to see an invariant bite.
// Each knob names the code it stands for.

module asks {
  // ---- knobs ------------------------------------------------------------------------------------------------------
  // true: a row Ash added by hand counts as "untouched" and is replaced when the model's list for its message lands
  // (asks.ts withHeard: status heard and one history step). false: a hand-added row is kept like a touched one.
  pure val HAND_ASK_REPLACED = true
  // How many "maybe" rows a re-hearing may leave for one message (asks.ts MAYBE_PER_MESSAGE, 6 in the code; 1 here so
  // two asks are enough to pass it). An ask the rules heard and the model's list left out is kept as a maybe only while
  // there is room; past that it is gone.
  pure val MAYBE_CAP = 1
  // false: no path takes a stuck ask to the person. true: the app surfaces an ask (a Needs you entry) once it has sat
  // open and unseen for ESC_AFTER days, the promise of the spec's turn-end check ("in red, in Needs you").
  pure val ESCALATE = false
  // Deliberately broken variants, off in the real code (asks.ts changeProblem; askStore load):
  pure val MATE_CAN_DROP = false
  pure val RESTART_LOSES_WAITING = false

  pure val SLOTS = Set(1, 2, 3)
  pure val MISSED = 3
  pure val STATUSES = Set("unheard", "heard", "maybe", "started", "waiting", "done", "dropped", "gone")
  pure val ESC_AFTER = 2
  pure val MAX_AGE = 3

  // st: unheard (said, not on the ledger), heard, maybe, started, waiting, done, dropped, or gone (was on the ledger, is not).
  // touched: a status was changed by someone (history longer than one step).
  // hand: Ash added it by hand.
  // job: the crew's job for it: none, running, completed, failed.
  // orphan: the job's owner chat was reset, so its report can no longer be delivered.
  // reported: the first mate has been told how the job ended.
  // knows: the first mate has this ask in front of it (the open_asks note, a nudge, a report).
  // age: days it has sat heard or started and been shown to Ash nowhere but the receipt.
  // told: the app has put it in front of Ash (a Needs you entry): only when ESCALATE.
  // dropper: who dropped it: "", "person" or "mate".
  type Row = {
    st: str,
    touched: bool,
    hand: bool,
    job: str,
    orphan: bool,
    reported: bool,
    knows: bool,
    age: int,
    told: bool,
    dropper: str
  }

  var rows: int -> Row
  // the chat the asks were made in is open and idle, so the app can send into it
  var chatOpen: bool
  // turn-end nudges sent since Ash's last message (the cap is 2, askNotes.ts ASK_NUDGE_CAP)
  var nudges: int

  pure def isOpen(r: Row): bool = or { r.st == "heard", r.st == "maybe", r.st == "started", r.st == "waiting" }
  pure def terminal(j: str): bool = or { j == "completed", j == "failed" }
  // open, and Ash has been shown nothing beyond the receipt
  pure def stuck(r: Row): bool = and { or { r.st == "heard", r.st == "started" }, not(r.told) }

  pure val blank: Row = {
    st: "unheard", touched: false, hand: false, job: "none", orphan: false,
    reported: false, knows: false, age: 0, told: false, dropper: ""
  }
  // someone changed its status
  pure def moved(r: Row, st: str, who: str): Row = {
    ...r,
    st: st,
    touched: true,
    age: 0,
    dropper: if (st == "dropped") who else r.dropper
  }
  pure def withSt(r: Row, st: str): Row = { ...r, st: st }
  pure def withKnows(r: Row, k: bool): Row = { ...r, knows: k }
  pure def withJob(r: Row, j: str): Row = { ...r, job: j }
  pure def aged(r: Row): Row = { ...r, age: r.age + 1 }
  pure def told(r: Row): Row = { ...r, told: true }
  pure def reportedTo(r: Row): Row = { ...r, reported: true, knows: true }
  pure def delegated(r: Row): Row = { ...r, job: "running", orphan: false, reported: false }
  pure def handMade(r: Row, touched: bool): Row = { ...r, st: "heard", hand: true, touched: touched }
  // the owner chat was reset: a job still running is orphaned, and nothing is in front of the first mate
  pure def afterReset(r: Row): Row = { ...r, knows: false, orphan: or { r.orphan, r.job == "running" } }
  // the app comes back: the first mate's turn was cut, so nothing is in front of it
  pure def afterRestart(r: Row): Row =
    if (and { RESTART_LOSES_WAITING, r.st == "waiting" }) { ...r, st: "gone", knows: false } else { ...r, knows: false }
  // a heard, started or waiting ask goes beside Ash's next message
  pure def shown(r: Row): Row =
    if (or { r.st == "heard", r.st == "started", r.st == "waiting" }) { ...r, knows: true } else r

  pure def othersMaybe(m: int -> Row, i: int): int =
    SLOTS.filter(j => and { j != i, m.get(j).st == "maybe" }).size()

  action setRows(newRows: int -> Row): bool = all {
    rows' = newRows,
    chatOpen' = chatOpen,
    nudges' = nudges
  }

  action init = {
    nondet opened = Set(true, false).oneOf()
    all {
      rows' = SLOTS.mapBy(i => blank),
      chatOpen' = opened,
      nudges' = 0
    }
  }

  // ---- the app: hearing Ash's message ------------------------------------------------------------------------------
  // The quick reading or the model's list puts a slot on the ledger as heard (useAskLedger.ts, askStore.hear).
  action extract(i: int): bool = all {
    i != MISSED,
    rows.get(i).st == "unheard",
    setRows(rows.set(i, withSt(rows.get(i), "heard")))
  }

  // The same message heard again: the model's list landing after the rules' quick one, a retry, a second window.
  // Rows nobody has touched are replaced by the new list (asks.ts withHeard). "same": the new list holds it. "omit": it
  // does not. A heard ask the model left out becomes a maybe if there is room (hearMessage, MAYBE_PER_MESSAGE), else it is
  // gone; Ash's hand-added row is gone when HAND_ASK_REPLACED.
  action rehear(i: int): bool = {
    nondet outcome = Set("same", "omit").oneOf()
    val r = rows.get(i)
    all {
      or { r.st == "heard", r.st == "maybe" },
      not(r.touched),
      setRows(rows.set(i,
        if (outcome == "same") r
        else if (r.hand) withSt(r, "gone")
        else if (othersMaybe(rows, i) < MAYBE_CAP) withSt(r, "maybe")
        else withSt(r, "gone")
      ))
    }
  }

  // The turn-end nudge: asks still "heard" when a turn ends are named to the first mate, at most twice in a row.
  action nudge = all {
    chatOpen,
    nudges < 2,
    SLOTS.exists(i => rows.get(i).st == "heard"),
    rows' = SLOTS.mapBy(i => if (rows.get(i).st == "heard") withKnows(rows.get(i), true) else rows.get(i)),
    chatOpen' = chatOpen,
    nudges' = nudges + 1
  }

  // Ash sends a message (or the daily check fires into an open chat): the open asks go beside it, in a fresh session
  // always (App.tsx openAsksNote). The cap on nudges starts again.
  action inject = all {
    chatOpen,
    rows' = SLOTS.mapBy(i => shown(rows.get(i))),
    chatOpen' = chatOpen,
    nudges' = 0
  }

  // ---- the first mate (and its crew) --------------------------------------------------------------------------------
  // asks.update status started: the first mate hands it to a worker.
  action mateStart(i: int): bool = {
    val r = rows.get(i)
    all {
      chatOpen,
      r.knows,
      or { r.st == "heard", r.st == "maybe", r.st == "waiting" },
      setRows(rows.set(i, delegated(moved(r, "started", "mate"))))
    }
  }

  // asks.update status done with proof "answered in this chat": a small ask the reply covered.
  action mateDoneDirect(i: int): bool = {
    val r = rows.get(i)
    all {
      chatOpen,
      r.knows,
      r.st == "heard",
      setRows(rows.set(i, moved(r, "done", "mate")))
    }
  }

  // done, with the worker's report as the proof.
  action mateDoneAfterJob(i: int): bool = {
    val r = rows.get(i)
    all {
      chatOpen,
      r.knows,
      or { r.st == "started", r.st == "waiting" },
      r.job == "completed",
      r.reported,
      setRows(rows.set(i, moved(r, "done", "mate")))
    }
  }

  // asks.update status waiting with a note: it needs Ash's call, or the worker failed and the first mate says so.
  action mateWaiting(i: int): bool = {
    val r = rows.get(i)
    all {
      chatOpen,
      r.knows,
      or { r.st == "heard", and { r.st == "started", r.job == "failed", r.reported } },
      setRows(rows.set(i, moved(r, "waiting", "mate")))
    }
  }

  // Only when MATE_CAN_DROP, a deliberately broken variant: the real changeProblem refuses it.
  action mateDrop(i: int): bool = {
    val r = rows.get(i)
    all {
      MATE_CAN_DROP,
      chatOpen,
      r.knows,
      isOpen(r),
      setRows(rows.set(i, moved(r, "dropped", "mate")))
    }
  }

  // The crew: a delegated job ends, finished or failed (a worker crash settles as failed; delegations.ts settle).
  action jobFinish(i: int): bool = {
    nondet result = Set("completed", "failed").oneOf()
    val r = rows.get(i)
    all {
      r.job == "running",
      setRows(rows.set(i, withJob(r, result)))
    }
  }

  // The app queues the worker's report into the owner chat (queueMonoSessionCompletion). It needs that chat open and
  // still the owner: a reset chat's jobs are never reported (App.tsx returns when the owner is not a first mate chat).
  action report(i: int): bool = {
    val r = rows.get(i)
    all {
      terminal(r.job),
      not(r.reported),
      not(r.orphan),
      chatOpen,
      setRows(rows.set(i, reportedTo(r)))
    }
  }

  // ---- the person -----------------------------------------------------------------------------------------------------
  action personDrop(i: int): bool = {
    val r = rows.get(i)
    all {
      isOpen(r),
      setRows(rows.set(i, moved(r, "dropped", "person")))
    }
  }

  action personDone(i: int): bool = {
    val r = rows.get(i)
    all {
      isOpen(r),
      setRows(rows.set(i, moved(r, "done", "person")))
    }
  }

  action personReopen(i: int): bool = {
    val r = rows.get(i)
    all {
      or { r.st == "done", r.st == "dropped" },
      setRows(rows.set(i, moved(r, "heard", "person")))
    }
  }

  // "Yes, this is an ask" on a maybe line.
  action personSettle(i: int): bool = {
    val r = rows.get(i)
    all {
      r.st == "maybe",
      setRows(rows.set(i, moved(r, "heard", "person")))
    }
  }

  // "Add one that was missed" under a message that has a receipt (AskReceipt.tsx AddAsk, askStore.add).
  action handAdd(i: int): bool = {
    val r = rows.get(i)
    all {
      r.st == "unheard",
      SLOTS.exists(j => or { rows.get(j).st == "heard", rows.get(j).st == "maybe" }),
      setRows(rows.set(i, handMade(r, not(HAND_ASK_REPLACED))))
    }
  }

  action openChat = all {
    not(chatOpen),
    rows' = rows,
    chatOpen' = true,
    nudges' = nudges
  }

  action closeChat = all {
    chatOpen,
    rows' = rows,
    chatOpen' = false,
    nudges' = nudges
  }

  // Ash resets the first mate's chat: a fresh chat, the old one removed. The first mate has nothing in front of it, and a
  // job that was running for the old chat is orphaned (resetMonoSession; no delegation is re-pointed).
  action resetMate = all {
    rows' = SLOTS.mapBy(i => afterReset(rows.get(i))),
    chatOpen' = true,
    nudges' = 0
  }

  // ---- the app: restart, tidy, time ------------------------------------------------------------------------------------
  // The app quits and comes back. The ledger is on disk and is read again; a first mate's turn is cut, so it has nothing in
  // front of it until the next turn starts. (RESTART_LOSES_WAITING is a broken variant: the real store keeps every row.)
  action restart = all {
    rows' = SLOTS.mapBy(i => afterRestart(rows.get(i))),
    chatOpen' = chatOpen,
    nudges' = nudges
  }

  // The chat's history is compacted (a tidy): the engine's context is fresh. The ledger is not touched.
  action compact = all {
    rows' = SLOTS.mapBy(i => withKnows(rows.get(i), false)),
    chatOpen' = chatOpen,
    nudges' = nudges
  }

  // A day passes. An ask that is heard or started and shown to Ash nowhere but the receipt ages. When ESCALATE, a day cannot
  // pass while an ask that is due for escalation has not been escalated: the standard way to say an action is weakly fair.
  action tick = all {
    not(and { ESCALATE, SLOTS.exists(i => and { stuck(rows.get(i)), rows.get(i).age >= ESC_AFTER }) }),
    rows' = SLOTS.mapBy(i => if (stuck(rows.get(i))) aged(rows.get(i)) else rows.get(i)),
    chatOpen' = chatOpen,
    nudges' = nudges
  }

  // Only when ESCALATE: the app puts a quiet ask in front of Ash (a Needs you entry). Not in the code today.
  action escalate(i: int): bool = {
    val r = rows.get(i)
    all {
      ESCALATE,
      stuck(r),
      r.age >= ESC_AFTER,
      setRows(rows.set(i, told(r)))
    }
  }

  action step = {
    nondet i = SLOTS.oneOf()
    any {
      extract(i),
      handAdd(i),
      rehear(i),
      nudge,
      inject,
      mateStart(i),
      mateDoneDirect(i),
      mateDoneAfterJob(i),
      mateWaiting(i),
      mateDrop(i),
      jobFinish(i),
      report(i),
      personDrop(i),
      personDone(i),
      personReopen(i),
      personSettle(i),
      openChat,
      closeChat,
      resetMate,
      restart,
      compact,
      tick,
      escalate(i)
    }
  }

  // ---- what must hold ---------------------------------------------------------------------------------------------------
  // Safety. Every ask is in exactly one known state.
  val inv_known = SLOTS.forall(i => STATUSES.contains(rows.get(i).st))
  // An ask that anyone has acted on is never lost.
  val inv_touchedNeverGone = SLOTS.forall(i => or { not(rows.get(i).touched), rows.get(i).st != "gone" })
  // No ask that was on the ledger is ever gone.
  val inv_neverGone = SLOTS.forall(i => rows.get(i).st != "gone")
  // Only the person can drop an ask.
  val inv_dropIsPersons = SLOTS.forall(i => rows.get(i).dropper != "mate")
  // Liveness, in its bounded form: an ask the app has heard does not sit open for more than MAX_AGE days with nothing in
  // front of Ash but the receipt. (Weak fairness of the app's escalation is the urgency in `tick`.)
  val inv_noStarvation = SLOTS.forall(i => rows.get(i).age <= MAX_AGE)
}
