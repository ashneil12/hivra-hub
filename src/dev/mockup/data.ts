// The design mockup's example dataset (seed.ts). Made up from start to finish: invented projects' work, no real chats,
// no real people besides "you". Shapes follow what the native side returns (delegations.rs, decisions, sessions).

const ROOT = "/Users/example/Projects";

export type ExampleProject = { id: string; name: string; shortName: string; iconShape: string; folder: string | null };

const projects: ExampleProject[] = [
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "gamepad", folder: `${ROOT}/exo` },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: `${ROOT}/hivra` },
  { id: "nibbii", name: "Nibbii", shortName: "Nibbii", iconShape: "heart", folder: `${ROOT}/nibbii` },
  { id: "safetube", name: "SafeTube", shortName: "SafeTube", iconShape: "play", folder: `${ROOT}/safetube` },
];

const CHIEF_FOLDER = "/Users/ash/Library/Application Support/com.ash.monocode-hub.dev.browser/mono-teams/chief-of-staff";

const folderOf = (id: string) => projects.find((p) => p.id === id)?.folder ?? ROOT;

/** Each Mono's own chat, by a fixed id, so the workers below can name who sent them. */
const CHAT = {
  chief: "mockup-chat-chief",
  /** A side chat the Chief of Staff had before it became one chat: kept, and Search still finds it. */
  chiefEarlier: "mockup-chat-chief-earlier",
  /** And the chat it had of its own in Hivra: kept in that project's list, under Everyone. */
  chiefHivraEarlier: "mockup-chat-chief-hivra-earlier",
  exo: "mockup-chat-exo-lead",
  hivra: "mockup-chat-hivra-lead",
  nibbii: "mockup-chat-nibbii-lead",
  safetube: "mockup-chat-safetube-lead",
  designer: "mockup-chat-designer",
  marketing: "mockup-chat-marketing",
} as const;

function roster() {
  return [
    {
      id: "chief-of-staff",
      name: "Chief of Staff",
      role: "Runs the ship for you",
      mascot: "cat",
      mascotPicked: true,
      color: "hsl(268 70% 66%)",
      projects: [],
      everyProject: true,
      captain: true,
      templateId: "coordinator",
      sessionId: CHAT.chief,
      chats: [CHAT.chiefEarlier],
      projectSessions: { hivra: CHAT.chiefHivraEarlier },
    },
    { id: "vg-game-lead", name: "EXO lead", mascot: "invader", mascotPicked: true, color: "hsl(211 92% 62%)", projects: [folderOf("vg-game")], engine: "claude", sessionId: CHAT.exo },
    { id: "hivra-lead", name: "Hivra lead", mascot: "ghost", mascotPicked: true, color: "hsl(12 80% 58%)", projects: [folderOf("hivra")], engine: "claude", sessionId: CHAT.hivra },
    { id: "nibbii-lead", name: "Nibbii lead", mascot: "robot", mascotPicked: true, color: "hsl(45 90% 55%)", projects: [folderOf("nibbii")], engine: "claude", sessionId: CHAT.nibbii },
    { id: "safetube-lead", name: "SafeTube lead", mascot: "crab", mascotPicked: true, color: "hsl(142 55% 50%)", projects: [folderOf("safetube")], engine: "claude", sessionId: CHAT.safetube },
    { id: "designer", name: "Iris", role: "Design review", mascot: "robot", color: "hsl(320 60% 62%)", projects: [folderOf("hivra"), folderOf("nibbii")], sessionId: CHAT.designer },
    { id: "marketing", name: "Milo", role: "Marketing", mascot: "robot", color: "hsl(180 55% 50%)", projects: [folderOf("safetube")], sessionId: CHAT.marketing },
  ];
}

type Line = [role: "user" | "assistant", text: string];

function chat(id: string, title: string, cwd: string, lines: Line[], now: number, minutesAgo: number) {
  const start = now - minutesAgo * 60_000;
  return {
    id,
    title,
    cwd,
    harness: "claude",
    model: "opus",
    runtimeMode: "supervised",
    createdAt: start - 3 * 3_600_000,
    updatedAt: start + lines.length * 60_000,
    modelSettings: {},
    blocks: lines.map(([role, text], i) => ({
      id: `${id}-b${i}`,
      role,
      text,
      ...(role === "user" ? { startedAt: start + i * 60_000, durationMs: 40_000 } : {}),
    })),
  };
}

/**
 * The Needs you roll-up the app posts when something new needs Ash (needs/model/needsRollup.ts), placed after the
 * block at `after`: its item is answered where it sits (asks/ui/InlineNeed.tsx).
 */
function withRollup<T extends { id: string; blocks: { id: string; role: string }[] }>(session: T, after: number, now: number): T {
  const item = { key: "question:nibbii:onboarding-read", sentence: "Read the onboarding copy before it goes out?", where: "Nibbii", projectId: "nibbii", yours: false };
  const block = {
    id: `needs-rollup-${now - 20 * 60_000}`,
    role: "system",
    text: `Needs you now:\n- Nibbii: ${item.sentence}`,
    needsRollup: { items: [item], more: 0 },
  };
  return { ...session, blocks: [...session.blocks.slice(0, after + 1), block, ...session.blocks.slice(after + 1)] };
}

/** A side question kept with the chat, on the message it was asked under (sessions/model/btw.ts): it comes back as a tab. */
function withSideQuestion<T extends { id: string; blocks: { id: string; role: string }[] }>(session: T, now: number): T {
  const at = now - 30 * 60_000;
  const thread = {
    id: `${session.id}-side-1`,
    sourceEndBlockId: session.blocks[1]?.id,
    createdAt: at,
    updatedAt: at + 20_000,
    status: "ready",
    harness: "claude",
    messages: [
      { id: `${session.id}-side-1-q`, role: "user", text: "Example: which rooms are in Area 3 again?", createdAt: at },
      { id: `${session.id}-side-1-a`, role: "assistant", text: "Example: the gate room, the flooded hall and the lift, then the boss arena.", createdAt: at + 20_000 },
    ],
  };
  return { ...session, blocks: session.blocks.map((block, index) => (index === 0 ? { ...block, btwThreads: [thread] } : block)) };
}

function sessions(now: number) {
  return [
    withRollup(chat(CHAT.chief, "Chief of Staff", ROOT, [
      ["user", "Morning. What needs me today?"],
      [
        "assistant",
        "Morning. Three things, and none of them is urgent before lunch.\n\n1. **EXO**: the playtest upload stopped (out of credits on the build service). Top it up or let me move it to the spare account.\n2. **Hivra**: pick the waitlist headline. The two versions tested about the same, so it's your taste call.\n3. **Nibbii**: the onboarding copy is ready for a read. Five minutes.\n\nI decided 14 smaller things overnight. They're under *Decided for you* if you want to check any.",
      ],
      ["user", "Move the EXO upload to the spare account. I'll do the headline after lunch."],
      [
        "assistant",
        "Done. The EXO lead is re-running the upload on the spare account now, and I'll remind you about the headline at 14:00.",
      ],
      ["user", "Example: anything I can answer right now?"],
      [
        "assistant",
        // A question answered where it sits (asks/model/needLinks.ts): each link draws as that question's own card.
        "Two quick ones, both with a pick ready:\n\n[Which take for the boss music?](hivra://local/need/question%3Avg-game%3Aboss-music)\n\n[Which waitlist headline?](hivra://local/need/question%3Ahivra%3Awaitlist-headline)\n\nThe Nibbii read can wait until tomorrow.",
      ],
    ], now, 50), 3, now),
    // In the folder the mock gives the Chief of Staff's own chats (browserTauriMock.ts mono_team_dir), where a side chat lives.
    chat(CHAT.chiefEarlier, "Example: parents' newsletter wording", CHIEF_FOLDER, [
      ["user", "Example: tighten the parents' newsletter opening line."],
      ["assistant", "Example: \"One safe place for the videos your kids already love.\" Twelve words, and it says what it is."],
    ], now, 60 * 26),
    chat(CHAT.chiefHivraEarlier, "Example: waitlist plan", folderOf("hivra"), [
      ["user", "Example: what is the plan for the Hivra waitlist?"],
      ["assistant", "Example: page first, then the email. The Hivra lead has both."],
    ], now, 60 * 30),
    withSideQuestion(chat(CHAT.exo, "EXO lead", folderOf("vg-game"), [
      ["user", "Where are we on the Area 3 build?"],
      [
        "assistant",
        "Area 3's three rooms are blocked out and playable. Two workers are on it now:\n\n- **Boss arena lighting**, about half done.\n- **Controller layout**: dodge moved to the right bumper after the playtest.\n\nThe playtest upload stopped on credits; the Chief of Staff moved it to the spare account and it's running again.",
      ],
      ["user", "Example: how is the boss music coming along?"],
      [
        "assistant",
        "Example: two takes are ready. Take A opens on the drums and hits harder. Take B opens on the choir and builds slower.\n\nWhich take for the boss music? I'd go with take A. Both are in Needs you so you can answer from there.",
      ],
      ["user", "Example: and the controller layout?"],
      ["assistant", "Example: dodge is on the right bumper now. Nobody in the last playtest asked where it was."],
      ["user", "Example: what is left before the Area 3 playtest?"],
      [
        "assistant",
        "Example: three things.\n\n1. The boss arena lighting, about half done.\n2. The boss music, waiting on your pick.\n3. One more pass on the checkpoint before the arena.\n\nI'll tell you when the build is up.",
      ],
    ], now, 35), now),
    chat(CHAT.hivra, "Hivra lead", folderOf("hivra"), [
      ["user", "Can you get the waitlist page ready to ship?"],
      [
        "assistant",
        "Yes. I split it into three pieces and sent each to a worker:\n\n1. Page layout and copy slots (working)\n2. Email capture and the thank-you note (working)\n3. Speed check on phones (waiting for 1)\n\nThe one thing I need from you is the headline. I put both options in Needs you.",
      ],
    ], now, 20),
    chat(CHAT.nibbii, "Nibbii lead", folderOf("nibbii"), [
      ["user", "Write the first-run onboarding copy."],
      ["assistant", "Done and merged. Four screens, under 20 words each. The Chief of Staff asked you to give it a read when you have five minutes."],
    ], now, 140),
    chat(CHAT.safetube, "SafeTube lead", folderOf("safetube"), [
      ["user", "Plan the parents' launch email."],
      ["assistant", "Draft is with Milo for a tone pass. Nothing needs you yet."],
    ], now, 300),
    chat(CHAT.designer, "Iris", folderOf("hivra"), [["user", "Review the new Home screen."], ["assistant", "Two notes: the Needs you count and the rail badge should agree, and the 'Working now' rows need the project name first."]], now, 400),
    chat(CHAT.marketing, "Milo", folderOf("safetube"), [["user", "Tone pass on the launch email, please."], ["assistant", "Softer opening, one clear button, dropped the third paragraph. Back with the SafeTube lead."]], now, 290),
  ];
}

type Row = {
  id: string;
  owner: string;
  mono: string;
  project: string;
  title: string;
  state: "running" | "completed" | "failed" | "question";
  status: "working" | "needs-you" | "done" | "failed" | "paused";
  minutesAgo: number;
  parent?: string;
  notice?: string;
  result?: string;
  error?: string;
  errorClass?: string;
};

function delegation(r: Row, now: number) {
  const at = now - r.minutesAgo * 60_000;
  const settled = r.state === "completed" || r.state === "failed";
  return {
    id: r.id,
    ownerSession: r.owner,
    ownerMono: r.mono,
    batchId: `batch-${r.mono}`,
    parentId: r.parent ?? null,
    rootId: r.parent ?? r.id,
    childSession: `mockup-worker-${r.id}`,
    requestId: `req-${r.id}`,
    generation: 1,
    project: r.project,
    title: r.title,
    brief: r.title,
    goal: null,
    askIds: [],
    state: r.state,
    errorClass: r.errorClass ?? null,
    error: r.error ?? null,
    retryable: null,
    resetsAt: null,
    result: r.result ?? null,
    pendingQuestion: null,
    delivery: settled ? "acknowledged" : "pending",
    deliveryMessage: null,
    createdAt: at,
    updatedAt: at + 5 * 60_000,
    settledAt: settled ? at + 30 * 60_000 : null,
    log: [],
    version: 1,
    mirroredVersion: 1,
    mirrorError: null,
    status: r.status,
    statusNotice: r.notice ?? null,
  };
}

function delegations(now: number) {
  const rows: Row[] = [
    { id: "exo-arena", owner: CHAT.exo, mono: "vg-game-lead", project: "vg-game", title: "Light the Area 3 boss arena", state: "running", status: "working", minutesAgo: 40 },
    { id: "exo-pad", owner: CHAT.exo, mono: "vg-game-lead", project: "vg-game", title: "Move dodge to the right bumper", state: "running", status: "working", minutesAgo: 25 },
    { id: "exo-upload", owner: CHAT.exo, mono: "vg-game-lead", project: "vg-game", title: "Upload the playtest build", state: "failed", status: "needs-you", minutesAgo: 8, error: "Example: out of credits on the build service", errorClass: "billing", notice: "Out of credits on the build service" },
    { id: "hv-layout", owner: CHAT.hivra, mono: "hivra-lead", project: "hivra", title: "Waitlist page layout and copy slots", state: "running", status: "working", minutesAgo: 18 },
    { id: "hv-email", owner: CHAT.hivra, mono: "hivra-lead", project: "hivra", title: "Email capture and thank-you note", state: "running", status: "working", minutesAgo: 16 },
    { id: "hv-speed", owner: CHAT.hivra, mono: "hivra-lead", project: "hivra", title: "Speed check on phones", state: "running", status: "paused", minutesAgo: 15, notice: "Waits for the page layout" },
    { id: "nb-copy", owner: CHAT.nibbii, mono: "nibbii-lead", project: "nibbii", title: "First-run onboarding copy", state: "completed", status: "done", minutesAgo: 150, result: "Merged: four onboarding screens." },
    { id: "nb-icons", owner: CHAT.nibbii, mono: "nibbii-lead", project: "nibbii", title: "Redraw the tab bar icons", state: "completed", status: "done", minutesAgo: 95, result: "Merged: five icons, light and dark." },
    { id: "st-email", owner: CHAT.safetube, mono: "safetube-lead", project: "safetube", title: "Draft the parents' launch email", state: "running", status: "working", minutesAgo: 60 },
  ];
  return rows.map((r) => delegation(r, now));
}

function decisions(now: number) {
  const open = (project: string, key: string, question: string, options: string[], recommended: string, minutesAgo: number, mono: string, owner: string) => ({
    project,
    decisionKey: key,
    question,
    options,
    recommended,
    askedBy: owner,
    askedByMono: mono,
    waiting: [],
    state: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    answerReason: null,
    createdAt: now - minutesAgo * 60_000,
    updatedAt: now - minutesAgo * 60_000,
    version: 1,
  });
  const decided = (project: string, key: string, question: string, options: string[], answer: string, reason: string, minutesAgo: number) => ({
    ...open(project, key, question, options, answer, minutesAgo + 5, "chief-of-staff", CHAT.chief),
    state: "answered",
    answer,
    answeredBy: "chief-of-staff",
    answeredAt: now - minutesAgo * 60_000,
    answerReason: reason,
  });
  return [
    open("hivra", "waitlist-headline", "Which waitlist headline?", ["Your agents, one captain", "Ship more, decide less"], "Ship more, decide less", 22, "hivra-lead", CHAT.hivra),
    open("nibbii", "onboarding-read", "Read the onboarding copy before it goes out?", ["Yes, show me", "Ship it as is"], "Yes, show me", 140, "nibbii-lead", CHAT.nibbii),
    open("vg-game", "boss-music", "Which take for the boss music?", ["Take A: drums first", "Take B: choir first"], "Take A: drums first", 70, "vg-game-lead", CHAT.exo),
    decided("vg-game", "upload-account", "Move the playtest upload to the spare account?", ["Yes", "Wait for top-up"], "Yes", "You asked for it in chat this morning.", 45),
    decided("hivra", "font", "Keep Inter for the waitlist page?", ["Keep Inter", "Try a serif"], "Keep Inter", "Matches the app; you said no new fonts last week.", 200),
    decided("safetube", "send-time", "Send the launch email on Tuesday or Thursday?", ["Tuesday", "Thursday"], "Tuesday", "Opens were higher on Tuesdays in the last three sends.", 260),
  ];
}

// Kept pages (pages.ts reads `monocode:pages` with no record store), some pinned so the project homes show them.
function pages(now: number) {
  const page = (id: string, projectId: string, title: string, by: string, pinned: boolean, blocks: unknown[]) => ({
    id, projectId, title, request: title, by, spec: { kind: "blocks", title, blocks }, permissions: [], keptAt: now - 3_600_000,
    // Who built it is who a change is asked of first.
    monoId: by === "Chief of Staff" ? "chief-of-staff" : by === "EXO lead" ? "vg-game-lead" : by === "SafeTube lead" ? "safetube-lead" : undefined,
    ...(pinned ? { pinned: true, pinnedBy: by } : {}),
  });
  return [
    page("page-safetube-launch", "safetube", "Launch plan", "Chief of Staff", true, [
      { kind: "list", title: "Before Tuesday", rows: [
        { text: "Waitlist page live", state: "ok", label: "Done" },
        { text: "Launch email", state: "warn", label: "Headline" },
      ] },
    ]),
    page("page-safetube-signups", "safetube", "Waitlist signups", "SafeTube lead", true, [
      { kind: "chart", title: "Signups this week", bars: [{ label: "Mon", value: 12 }, { label: "Tue", value: 30 }, { label: "Wed", value: 38 }] },
    ]),
    page("page-exo-map", "vg-game", "Area 3 map", "EXO lead", true, [{ kind: "note", title: "Area 3", text: "Three rooms and the boss arena." }]),
    page("page-hivra-roadmap", "hivra", "Roadmap", "Chief of Staff", true, [{ kind: "note", title: "Next", text: "Waitlist, then the phone app." }]),
  ];
}

// What automations_list returns (the mock reads `monocode:dev-automations`).
function automations(now: number) {
  const auto = (id: string, project: string, name: string, scheduleKind: string, time: string, enabled = true) => ({
    id, name, prompt: name, harness: "claude", model: "", cwd: folderOf(project), workspaceMode: "current", reuseSession: true,
    runtimeMode: "supervised", triggerKind: "time", triggerEvent: "", scheduleKind, minute: 0, time, dayOfWeek: 1,
    missedRunGraceMinutes: 60, enabled, nextRunAt: now + 86_400_000, createdAt: now - 86_400_000, updatedAt: now - 86_400_000,
  });
  return [
    auto("auto-signups", "safetube", "Weekly signups report", "weekly", "09:00"),
    auto("auto-uptime", "safetube", "Tell me if the page goes down", "hourly", "00:00"),
    auto("auto-playtest", "vg-game", "Nightly playtest build", "daily", "02:00"),
    auto("auto-backup", "hivra", "Nightly backup", "daily", "03:00"),
    auto("auto-recipes", "nibbii", "Recipe ideas digest", "weekly", "10:00", false),
  ];
}

// Each project's Leadership team room (hubChats.ts reads `monocode:hub-chats`). SafeTube's and Hivra's councils have
// already decided things, so turning council mode on shows a thread with its earlier decisions in it. Each team has its
// members seated and one example conversation, so the team's chat shows how talking to a team works.
function rooms(now: number) {
  type Said = [from: string, text: string];
  const room = (projectId: string, memberIds: string[], title: string, said: Said[], past?: unknown[]) => ({
    id: `${projectId}:leadership`, projectId, name: "Leadership team", isDefault: true, seated: true, memberIds, leadId: memberIds[1],
    conversations: [
      {
        id: `${projectId}-talk-1`, when: "Today", title, named: true, createdAt: now - 3 * 3_600_000,
        messages: said.map(([from, text], i) => ({
          id: `${projectId}-talk-1-m${i}`, from, text, kind: from === "ash" ? "ash" : "mono", at: now - 3 * 3_600_000 + i * 90_000,
          ...(from !== "ash" && i > 1 ? { quiet: true } : {}),
        })),
      },
    ],
    ...(past
      ? {
          council: {
            revision: 1, generation: 0, question: "", preset: "triad", expectedCalls: 0, phase: "propose", seats: [], blind: [],
            cross: [], stances: [], retried: [], skipped: [], meta: { seats: 0, rounds: 0, calls: 0, tokensComplete: false }, past,
          },
        }
      : {}),
  });
  return [
    room("vg-game", ["chief-of-staff", "vg-game-lead"], "Area 3 before the playtest", [
      ["ash", "Example: is area 3 ready for Friday's playtest?"],
      ["vg-game-lead", "Example: the boss has both phases and the new music cue. The build is too big to upload, so I have a worker shrinking the textures."],
      ["chief-of-staff", "Example: I'll hold the playtest invite until the upload works, and tell you here."],
    ]),
    room("hivra", ["chief-of-staff", "hivra-lead", "designer"], "Waitlist page", [
      ["ash", "Example: what is left on the waitlist page?"],
      ["hivra-lead", "Example: layout and email capture are with two workers. The speed check on phones starts when they finish."],
      ["designer", "Example: I'd make the headline shorter. Both options are in Needs you."],
      ["chief-of-staff", "Example: once you pick the headline I'll get it shipped."],
    ], [
      { question: "Example: do we build the phone app before or after the waitlist?", consensus: true, winner: "waitlist first",
        nextStep: "Example: finish the waitlist page, then plan the phone app.", minority: "Example: Iris would start the phone app now." },
    ]),
    room("nibbii", ["chief-of-staff", "nibbii-lead", "designer"], "Onboarding copy", [
      ["ash", "Example: can the onboarding copy go out this week?"],
      ["nibbii-lead", "Example: the second pass is written. I'd like you to read it once before it ships."],
      ["designer", "Example: the three screens fit a small phone now."],
    ]),
    room("safetube", ["chief-of-staff", "safetube-lead", "marketing"], "Launch week plan", [
      ["ash", "Example: what is left before we open the waitlist?"],
      ["safetube-lead", "Example: the sign-up form works. The thank-you email still lands in spam on one phone, and a worker is on it."],
      ["marketing", "Example: the first 20 people are picked. I'll write to them the morning it opens."],
      ["chief-of-staff", "Example: so the only open item is the email. I'll tell you when it passes on both phones."],
    ], [
      { question: "Example: should the waitlist ask for the child's age?", consensus: true, winner: "don't ask",
        nextStep: "Example: keep the form to an email address only.", minority: "Example: Milo would ask, to plan the content." },
      { question: "Example: one launch email or a series of three?", consensus: false,
        nextStep: "Example: no consensus. Decide this yourself.", minority: "Example: two for one email, one for a series." },
    ]),
  ];
}

// What notes_list returns: a few example notes, so the Notes screen has something to open.
function notes(now: number) {
  const note = (id: string, title: string, body: string, tags: string[], project: string, hoursAgo: number) => ({
    id, slug: id, title, body, tags, sourceCwd: folderOf(project), slugPending: false,
    createdAt: now - (hoursAgo + 24) * 3_600_000, updatedAt: now - hoursAgo * 3_600_000,
  });
  return [
    note("launch-checklist", "Launch checklist", "## Before the waitlist opens\n\n- [x] Sign-up form works on a phone\n- [x] Thank-you email written\n- [ ] Thank-you email tested on two phones\n- [ ] Tell the first 20 people\n\nThe Chief of Staff keeps this list up to date.", ["launch"], "safetube", 2),
    note("boss-fight-ideas", "Boss fight ideas", "Three things the area 3 boss should do:\n\n1. Telegraph the big hit a full second early.\n2. Change the music when it is at half health.\n3. Leave one safe corner, so the fight is hard but fair.", ["design", "area-3"], "vg-game", 9),
    note("voice-and-tone", "How we write", "Short sentences. Say what happened, then what is next.\n\nNever say \"stuck\". Say what the work is waiting on.", ["writing"], "hivra", 30),
    note("recipe-sources", "Recipe sources to try", "- Grandma's notebook (scan it)\n- The three most saved posts from last month\n- Ask the waitlist what they cook on a weeknight", ["ideas"], "nibbii", 52),
  ];
}

// What the Inbox reads from GitHub: example issues and pull requests per project (git_github_work_items).
function inbox(now: number) {
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const item = (repo: string, kind: "issue" | "pr", number: number, title: string, hoursAgo: number, labels: Array<[string, string]> = [], draft = false) => ({
    kind, number, title, url: `https://github.com/example/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`, state: "OPEN",
    createdAt: iso(hoursAgo + 20), updatedAt: iso(hoursAgo), labels: labels.map(([name, color]) => ({ name, color })),
    assignees: [{ login: "you" }], draft, repo: `example/${repo}`,
  });
  return [
    item("safetube", "pr", 41, "Waitlist page: sign-up form and thank-you email", 1, [["launch", "0e8a16"]]),
    item("safetube", "issue", 39, "Thank-you email lands in spam on one phone", 5, [["bug", "d73a4a"]]),
    item("exo", "pr", 118, "Area 3 boss: second phase and new music cue", 3, [["gameplay", "5319e7"]]),
    item("exo", "issue", 112, "Playtest build is too big to upload", 7, [["build", "fbca04"]]),
    item("hivra", "pr", 27, "Home: one box to start a chat with the Chief of Staff", 2, [["design", "1d76db"]]),
    item("hivra", "issue", 25, "Hubs should open without a tab bar", 26, [["design", "1d76db"]]),
    item("nibbii", "pr", 9, "Onboarding copy, second pass", 11, [], true),
  ];
}

export const EXAMPLE = { projects, roster, sessions, delegations, decisions, pages, automations, rooms, notes, inbox };
