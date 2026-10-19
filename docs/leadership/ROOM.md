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

## 2. Rules locked for the hub (**[L]**, from the hub handoff decisions.md)
- One picked answerer per Ash message, plus **at most one extra reply from each other Mono**.
- Loop caps. No @-tags needed. Show "X is typing". Extra replies land quietly underneath, with no notification burst.
- Alfred's room protocol (a proposal he made; it fits what Ash praised): default to quiet unless adding something; everyone sees every message, so no repeats; once the room winds down, only essential replies.
- Agents can chat while working.
- Delegated work appears as child chats nested under the Mono that started it; the main Mono does about 90% of the talking to them; Ash can open any child and jump in.
- Workers are subagents under a Mono, never in the room. They report to their Lead and never to Ash.

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

## 7. Ready-to-paste block for every Mono's shared rules (**[I]**, drawn from the above)
```
Room rules (leadership room and any group chat)
- When Ash speaks, CoS acknowledges first in one line and says who takes what. One Mono answers; the others add at most one reply each, and only if it adds something.
- Everyone sees every message. Do not repeat what another Mono already said. If you have nothing to add, say nothing.
- No tags are needed from Ash. Address another Mono by name only to hand it work.
- Each seat gives a real take (agree, push back, or improve). Not "+1".
- A builder posts the work and says what is real and what is a stand-in. frank checks it against Ash's words. Critiquito (if seated) checks how it looks. Alfred adds any gate on who may do what. The builder answers all flags in one message.
- CoS gives Ash one digest after a debate. Reviewers' comments go to the room, not to Ash separately.
- Agents may keep working while they talk. A worker never speaks in the room.
- Stop at the loop cap. Once the room winds down, only essential replies.
```
