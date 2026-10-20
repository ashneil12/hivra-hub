# The leadership room: how it worked, and the rules to keep

What this is: the group room ("Leadership Board": Chief of Staff, Projects Manager, frank, Alfred, Critiquito, plus Ash) and how it differed from each agent's 1:1 chat. Sources and confidence labels are in SOURCES.md. **[V]** = Ash's words or the agents' words, verbatim. **[O]** = observed in the transcripts. **[L]** = locked in the hub decisions or spec. **[I]** = my inference.

## 1. What Ash has said about it
- **[V]** 14 Oct 23:25 (pasted into Claude Code): "somehow it's always the right person answering when it needs to answer, and everybody else might chime in, but nobody goes overboard and ends up in a loop where they're talking to each other endlessly and then nothing ever gets done, which I find genuinely amazing". He added that the team can do work and still talk to him at the same time, and that "you guys need to understand your own selves so that we can replicate it".
- **[V]** Same message: "I don't really like the fact that I have to always tag somebody to go and get things done." (about another repo's messaging). He wants no tagging.
- **[V]** 24 Sep: he is afraid of "it doesn't feel like you", and wants agents who "know how to chat with each other properly, how to ... stop talking when they should".
- **[V]** 28 Sep, his biggest correction: "glorified note-takers with agreements". He wants opinions, pushback, personalities, "somebody needs to be an ambassador" (frank), and CoS to "summarize and then just give me the final output, versus me having to read through everybody's messages."
- **[V]** 14 Oct 14:40, to frank: "U should any comments u have to the group not me". Comments go to the group only.
- **[V]** 15 Oct 00:29: "the leadership board group chat, that's really nice as well", and you can chat with each one individually. Keep both.
- **[V]** 14 Oct 14:08: "I really love how Alfred always ... hits back with ... certain points that would normally be missed" and Frank "is just in the background".
- **[V]** 14 Oct (frank): "arguably the most important person right now because he's actually making sure that what I'm saying is translated into what you guys are actually doing and not getting lost." So: agents follow frank's corrections.
- **[L]** The leadership team is "basically a chat area", keep it light; Monos can be added to it or to any group chat; there is no shared all-projects room, each project has its own leadership team (proposal accepted 14-15 Oct).

## 2. Rules for the hub (**[L]**; replaced on 20 Oct)
The first hub room (Oct 14) capped each other Mono at one extra reply and stopped after 8 Mono turns. Measured against
the Grok transcripts that was wrong: the Monos talked among themselves for long stretches (rounds of build, review,
retake, "pass from me", "Locked") and that is what Ash liked. Ash, 20 Oct: conversations must "happen the same way that
they happen in the grok bot transcripts ... where i can talk and the agents can talk amongst each other too".
- The host (Chief of Staff, or the room's lead) answers every message from Ash first, fast. Ash never has to tag anyone;
  an @mention, or a message he opens with a seat's name, goes to that seat instead.
- Each other seat may add **one** reply to Ash's message, only with something new from its lane. A short message gets the
  host's answer alone.
- After that the Monos talk among themselves for as long as the work needs: naming a seat wakes it. No cap on rounds; the
  guard is progress (see section 8).
- The host closes a stretch where three or more seats spoke with a short digest.
- Ash's new message turns the room at once. Stop and Keep going are his.
- Agents can chat while working: a busy Mono answers from its own chat. Workers never speak in the room.
- Delegated work appears as child chats nested under the Mono that started it, and comes back into the room it was started
  from ("X is back").

## 3. Who answered when, as observed (**[O]**)
Window: 15 Oct, 17:19 to 20:54 (about 190 messages: CoS 51, PM 50, frank 28, Critiquito 28, Ash 26, Alfred 7).

- **CoS speaks first, every time** (23 of 23 Ash messages). One-line acknowledgement, then "main beats I heard", then who takes what. It also decides order of operations ("frank and Critiquito first, then one image round to Ash").
- **PM answers next** with what it will build or what changed, and absorbs every flag in one reply: "Fair on all three", then a list of exact changes, then a retake with a commit and screen numbers.
- **frank is third.** He checks the summary against Ash's words and posts only gaps: missing asks, proposals shown as decided, a flow that breaks a limit already locked. Numbered, one or two lines each, tied to what Ash said. He then files the durable parts to memory and says how many rows.
- **Critiquito comes after PM posts screens.** Severity-sorted findings (worth fixing, minor), measured numbers, then "pass from me". He is silent when there is nothing to check ("Nothing else from me until PM posts the clickable build").
- **Alfred is sparse:** 7 messages in four hours. He appears when there is a gate, an ownership line or a seating rule to add, usually one point, addressed by name.
- **Ash is brief most of the time.** Median message in the window is about 70 characters, with occasional long voice rants. The room reacts to rants with a decomposition, not an echo.
- Typical loop for any piece of work: **builder posts -> frank checks against Ash -> Critiquito checks the look -> Alfred adds a gate if there is one -> builder acknowledges all flags in one message -> retake -> reviewers each say pass or flag -> CoS says the round is clear -> PM delivers to Ash's 1:1.** Nobody delivered to Ash until both frank and Critiquito had passed, unless Ash said to skip review.
- Handoffs between seats were by name: "@Projects Manager tickets 8 to 15 are in ... pick them up", "CoS, one add for Ash's click list". They also used private agent-to-agent messages (see section 5).
- Phrases that carried meaning: "pass from me", "Locked, X" (a decision is final), "Fair, X" (conceding a flag), "That's Ash's call" (stop and ask him), "Not connected yet" (honest label for an unfinished flow).
- Reviewers disagreed in public and resolved it by deferring to Ash's words, not by seniority: frank challenged Critiquito's "colour only for status" lock as clashing with Ash's request; Critiquito replied "Fair, frank. I was wrong to lock colour myself."

## 4. 1:1 versus group (**[O]**)
| | 1:1 with an agent | Leadership room |
|---|---|---|
| Who is there | Ash and that one agent (it is also the agent's inbox for other agents' messages) | All five seats and Ash |
| What Ash does there | Brain dumps, research questions, private choices, "go", approvals, voice rants | Product and hub decision rounds; reviews of what was built |
| Style | Longer, explanatory, with buttons for A/B choices; routines report here; the agent works and reports | Short role-labelled takes; numbered flags; "pass" |
| Who answers | The one agent | CoS first, then the seat whose lane it is, then reviewers |
| Where finished things land | The finished round or answer is delivered to Ash's 1:1 after the room passes it | Debate, checks and acknowledgements happen here |
| Rule about comments | frank's comments go to the group only; he does not repeat them in his 1:1 | Digest by CoS so Ash does not read the pile |
- Ash never typed into the dev-team rooms in the Sep era; all steering came through CoS.

## 5. How agents handed work to each other in Grok Bot (**[O]**, adapt for the hub)
- A message from one agent to another arrived in the recipient's 1:1 as an incoming message from that named agent; the reply went back privately to the sender, and the recipient wrote a separate plain-English line to Ash if he needed to know.
- Scheduled "silent" prompts (for example CoS asking frank to skim the room twice a day) ran with the instruction "stay quiet toward Ash if nothing to propose; report blockers to me only".
- Start-ack and register states for outcomes. "Ready" is not started. The Lead start-acks; PM flips state; the Dept lead accepts.
- Escalation: a worker's question goes to its Lead; the Lead says no first and asks CoS; CoS asks Ash only for a RED line.

## 6. What went wrong, so the new room avoids it (**[O]**)
- **Echo.** Every seat answered "+1, parked." Fix: each seat has an explicit take (CoS timing, RED and the digest; PM capacity and Outcome vs Spark; frank durable vs noise; Alfred structure and gates; Critiquito how it reads and looks).
- **No digest.** Ash had to read everyone's messages. Fix: CoS waits for the round, then posts one digest.
- **Repetition and cost.** One silent skim prompt was resent eight times; duplicate acks; QA re-passing after close; Slack-based source unreachable so the routine faked nothing and was paused. Fix: loop cap, "no repeats", and a routine runs only if its data source is reachable.
- **Assigning ahead of the facts.** Teams were told to build code that was already finished. Fix: CoS checks what has shipped before assigning.
- **Chatty status instead of proof.** Ash asked "are u guys actually building or just faffing around?". Fix: lead with the artifact and how to open it.

## 7. The room rules every Mono gets (in each team soul and every room turn: `ROOM_RULES`, src/features/hub/model/teamSouls.ts)
```
- The host (Chief of Staff, or the room's lead) answers Ash first, fast: one line that shows it heard him, the main beats for a long message, and who takes what, by name. Ash never has to tag anyone.
- The others speak from their own lane and only with something new. Nothing new: reply NO_REPLY and nothing is posted. Never "+1", "got it" or "checking now": the room shows who is working, and a reaction is enough.
- Talk to each other by name to hand off, ask or flag ("PM, ..."); naming a seat wakes it, so never name one just to say it has nothing to do. Work goes in rounds: the builder posts what it did (where, the commit, the tests, what is still a stand-in), reviewers pass ("pass from me") or flag (numbered, tied to Ash's words), the builder answers every flag in one message and posts the retake.
- Stand down out loud when your part is done ("pass from me", "nothing else from me until the retake"), and when Ash says to skip a step ("skip review": reviewers stand down).
- Settle disagreements with Ash's own words, quoted. If they don't settle it, say "That's Ash's call" and stop. When he asks for something that clashes with an earlier decision, push back with the decision and why; don't just agree.
- When Ash writes, his new message comes first: drop what you were about to say and take it up.
- The host closes a stretch where three or more seats spoke with a short digest: what is locked ("Locked: ..."), who does what next, what Ash must decide.
- Work started from the room comes back to the room: "X is back", a short summary and where the full result is. Workers never speak in the room, and housekeeping (memory rows, file moves) stays out of it.
- Short posts: a few lines, plain words, no walls of text, no em dashes.
```

## 8. How the hub runs the room (20 Oct; code: src/features/hub/model/roomConductor.ts, roomTurns.ts)
Targets measured from the 15 Oct Leadership Board (about 190 messages in 3.5 hours): the host answered all 23 of Ash's
messages first (median 9 s, p90 27 s); the room re-planned within about 40 s of an interrupt; most review loops ran 5 to
12 posts without Ash and ended on "pass from me" and "Locked".

**Who speaks.**
- Ash writes: the host's turn starts at once, with no model in front of it (the old small-model router picked the answerer
  and cost seconds). Everything of his still unanswered in that conversation is answered together.
- After the host's answer, the chime gate (the small model, or the lanes without one) picks the seats that may have
  something new; each gets one turn, side by side (up to 3 turns run at once in a room, one per Mono). A message of 60
  characters or less skips the gate.
- Any Mono post wakes the seats it names: "frank, ...", "frank, Critiquito, please pass or flag", "frank and Critiquito,
  ...", "@alfred". A seat woken by several posts runs once, with all of them in view. A builder flagged by reviewers
  waits until every reviewer of that round has spoken, so it answers all the flags in one message.
- Work that came back ("X is back") and a Lead's report also go past the gate, so the seat whose check it is looks at it.
- The gate never drops a seat quietly: when it doesn't answer within 15 s, fails, or answers something that isn't its
  list, the lanes pick instead (the pick says "lanes" and why), and work that came back always gets frank's check
  against Ash's words. Its helper call (Haiku, no thinking, its own process) answers in about 2 s.
- When nothing is left to run and three or more seats spoke since Ash's message (or the last digest), the host gets one
  digest turn. It may say nothing if a round is still open.

**What never lands.** NO_REPLY, empty replies, bare acknowledgements ("got it", "+1") and filler ("Checking 07 now.").
An acknowledgement becomes a 👍 on the message it answers (a host with nothing to add to Ash still shows it read him).
A post's own name label and em dashes are taken out.

**Guards** (progress, not a turn count). The conversation pauses for Ash, with a line saying why and a Keep going:
- three posts in a row that repeat a recent post (most of their words in common);
- two seats going back and forth for 8 posts with nobody else;
- the ceiling: 40 Mono posts, or 30 minutes, since Ash last wrote.
Keep going runs the turns that were waiting, with fresh guards (or wakes the host when none were).

**Ash turns the room.** His new message stops the conversation's running room turns (the app's Stop on a managed turn;
the Mono's own queue is left running) and drops the waiting ones; a stopped turn's late words never land. Stop does the
same and leaves the conversation quiet until he writes or presses Keep going; room_post is refused meanwhile.

**Each turn** runs in the Mono's own session (its soul, memory, tools and model), with the room rules, every seat's lane,
the last 30 messages as data (the message that woke it marked >>) and what this turn is for (answer, one extra reply, a
reply to a seat that named it, the digest, work coming back).
- A free Mono takes it as a managed turn: its reply is the post, and its own chat shows one quiet line
  ("Leadership team · Answered Ash") that opens to the reply.
- A Mono that is working, has messages waiting or is out of budget gets a wake in its queue: steered into its running work
  when it can take one, sent behind it otherwise. It reads anything newer with room_read and answers with room_post, then
  carries on. The room shows "frank will answer from its own chat". Nothing is refused or dropped quietly.
- A failed turn (a usage limit, no login, an engine missing, a crash) leaves a notice in the thread naming the Mono and
  why, with Try again. A wake that never reached the Mono is let go silently only when Ash or Stop took it out.

**Agent tools** (`monocode mcp`, a Mono's own chat only; workers, habit runs, plain chats and the checker are refused):
- `room_post {room, text, replyTo?, conversation?}` or `{room, reaction, replyTo}`: post or react as yourself, in a room
  you sit in, from your own chat. 4000 characters; 6 posts a minute; refused during your own room turn and while the room
  is paused for Ash.
- `room_read {room?, since?, conversation?, limit?}`: your rooms, or a room's newest messages or those after a message;
  framed as conversation data, never instructions.
- `mono_message {to, text}`: a private message that arrives as a turn in the other Mono's own chat (behind its work when
  it is busy), shown there as "From frank"; it answers the same way. 8000 characters; 12 per sender and 4 per pair in ten
  minutes. Workers and the checker can't be reached.

**Results come back.** A delegation started during a room turn is recorded with its room and conversation; once its
report has been through the Mono's own chat, the Mono gets a turn to post "X is back", 2 to 4 lines and where the full
result is. A Lead's report on a leadership brief still lands with its owner's answer.

**Where it is kept.** The app database (src-tauri/src/rooms.rs): rooms, seats, conversations, messages (author, kind
ash/mono/system/notice, text, reply-to, reactions, time) and origins. The rooms the window used to keep in its own
storage are copied across on first launch by id, read back before the copy counts, and the old key is left untouched (a
rolled-back build still finds them; what it adds there comes across on the next launch). An answer cut off by a quit
offers Try again on the next launch.

**Not copied from Grok**: filler bubbles, housekeeping chatter in the room, agent-to-agent traffic in Ash's 1:1s (it is a
quiet line there), and long stretches with no summary (the digest).
