// Dropwave preview: example data only. The repo is public, so nothing here comes from a real chat, project or person
// beyond the owner's first name the designs already use.

export type Who = "you" | "cos" | string; // a first mate id, or "you" / "cos"

export interface Msg {
  from: Who;
  text: string;
  /** A small card under the message (a link to a place, a result). */
  card?: { title: string; body: string; go?: Go };
}

export type Go =
  | { to: "project"; project: string }
  | { to: "mate"; project: string; mate: string }
  | { to: "team"; project: string; team: string }
  | { to: "questions" }
  | { to: "agents" }
  | { to: "place"; project: string; place: string }
  | { to: "settings"; project: string };

export interface Mate {
  id: string;
  name: string;
  letter: string;
  color: string;
  status: "working" | "needs" | "idle";
  chat: Msg[];
  crew: { task: string; pct: number; mins: number }[];
  decided: { what: string; why?: string }[];
}

export interface Team {
  id: string;
  name: string;
  members: string[]; // mate ids, plus "cos"
  chat: Msg[];
}

export interface Question {
  id: string;
  project: string;
  ask: string;
  why: string;
  options: string[];
  pick: number;
}

export interface Place {
  id: string;
  name: string;
  kind: "pages" | "notes" | "automations" | "list";
  items: { title: string; sub: string }[];
}

export interface Project {
  id: string;
  name: string;
  short: string;
  color: string;
  autopilot: boolean;
  blurb: string;
  chat: Msg[];
  mates: Mate[];
  teams: Team[];
  places: Place[];
  decidedToday: number;
  decided: { what: string; who: string; when: string }[];
  building: { what: string; who: string; mins: number }[];
  done: { what: string; who: string; when: string }[];
}

export const CREW_COLORS = {
  cos: "#B794F6",
  coding: "#5B9CF5",
  marketing: "#F0A35B",
  ops: "#6CCB8F",
  design: "#F28CB1",
  research: "#E8D26A",
};

function mate(
  id: keyof typeof CREW_COLORS,
  name: string,
  status: Mate["status"],
  chat: Msg[] = [],
  crew: Mate["crew"] = [],
  decided: Mate["decided"] = [],
): Mate {
  return {
    id,
    name,
    letter: name[0],
    color: CREW_COLORS[id],
    status,
    chat,
    crew,
    decided,
  };
}

const pagesPlace = (items: Place["items"]): Place => ({
  id: "pages",
  name: "Pages",
  kind: "pages",
  items,
});
const notesPlace = (items: Place["items"]): Place => ({
  id: "notes",
  name: "Notes",
  kind: "notes",
  items,
});
const autoPlace = (items: Place["items"]): Place => ({
  id: "automations",
  name: "Automations",
  kind: "automations",
  items,
});

export const HOME_ID = "home";

export function initialProjects(): Project[] {
  return [
    {
      id: HOME_ID,
      name: "Home",
      short: "H",
      color: "#3FA7C9",
      autopilot: true,
      blurb: "Your own life and anything that isn't a project yet.",
      chat: [
        { from: "you", text: "Morning. What happened overnight?" },
        {
          from: "cos",
          text: "Morning, Ash. Quiet night. Across your four projects the crews made 340 decisions and I only need you for 2 of them. SafeTube's waitlist page is built and fast, and EXO's boss arena is half lit. Nothing is on fire.",
          card: {
            title: "2 questions for you",
            body: "One headline pick, one $40 spend. About a minute.",
            go: { to: "questions" },
          },
        },
      ],
      mates: [
        mate(
          "research",
          "Research",
          "working",
          [
            {
              from: "you",
              text: "Find me a dentist near the new flat that's open Saturdays.",
            },
            {
              from: "research",
              text: "Found three within a mile. The closest has Saturday mornings and takes new patients. I put them in Notes with prices.",
            },
          ],
          [{ task: "Compare flight prices for March", pct: 40, mins: 6 }],
        ),
        mate("ops", "Ops", "idle"),
      ],
      teams: [],
      places: [
        notesPlace([
          { title: "Dentists open Saturdays", sub: "Research · today" },
          { title: "Things to sort before March", sub: "You · Monday" },
        ]),
        autoPlace([
          { title: "Morning summary", sub: "Every day at 08:00" },
          { title: "Questions batch", sub: "12:00 and 17:00" },
        ]),
      ],
      decidedToday: 12,
      decided: [
        {
          what: "Moved the dentist call to Thursday, your only free morning",
          who: "Chief of Staff",
          when: "09:12",
        },
        {
          what: "Renewed the domain for safetube.example for a year ($12)",
          who: "Ops",
          when: "08:40",
        },
      ],
      building: [
        { what: "Compare flight prices for March", who: "Research", mins: 6 },
      ],
      done: [{ what: "Shortlist of dentists", who: "Research", when: "09:05" }],
    },
    {
      id: "safetube",
      name: "SafeTube",
      short: "ST",
      color: "#E5484D",
      autopilot: true,
      blurb: "A video app parents can trust.",
      chat: [
        { from: "you", text: "How's launch prep going?" },
        {
          from: "cos",
          text: "On track for Tuesday 9:00. Coding got the page loading in 1.4 s on old phones, Marketing has the launch email ready, and Ops set up the signup list. The one thing left is the headline, which needs your taste.",
          card: {
            title: "Pick the headline",
            body: "Two options, both tested about the same.",
            go: { to: "questions" },
          },
        },
      ],
      mates: [
        mate(
          "coding",
          "Coding",
          "working",
          [
            { from: "you", text: "Can the page load faster on old phones?" },
            {
              from: "coding",
              text: "Yes. It loads in 2.8 s on a 2019 Android today. I've put a crew member on shrinking the images and another on the font; target is under 1.5 s. I'll tell you and the Chief of Staff when it's live, no action needed from you.",
            },
          ],
          [
            { task: "Shrink the page's images", pct: 60, mins: 12 },
            { task: "Load the font only where it's used", pct: 25, mins: 4 },
          ],
          [
            { what: "Kept Inter for the page", why: "you said no new fonts" },
            { what: "Hosted the page on the existing domain" },
          ],
        ),
        mate(
          "marketing",
          "Marketing",
          "needs",
          [
            { from: "you", text: "Draft the launch email." },
            {
              from: "marketing",
              text: "Done, and it's final except the headline, which should match the page. I've sent that one question up through the Chief of Staff.",
            },
          ],
          [{ task: "Tone pass on the launch email", pct: 70, mins: 9 }],
          [
            {
              what: "Send time Tuesday 9:00",
              why: "parents open email most then",
            },
          ],
        ),
        mate(
          "ops",
          "Ops",
          "idle",
          [],
          [],
          [{ what: "Turned on double opt-in for the waitlist" }],
        ),
      ],
      teams: [
        {
          id: "launch",
          name: "Launch room",
          members: ["cos", "coding", "marketing"],
          chat: [
            { from: "you", text: "Are we ready to launch Tuesday?" },
            {
              from: "cos",
              text: "Nearly. Coding, is the page fast enough? Marketing, is the email final?",
            },
            {
              from: "coding",
              text: "Page loads in 1.4 s on old phones as of 13:20. Ready.",
            },
            {
              from: "marketing",
              text: "Email is final except the headline, which matches the page. Waiting on Ash's pick.",
            },
            {
              from: "cos",
              text: "Then the only thing left is the headline. It's in your questions, Ash. Once you pick, both go out Tuesday 9:00.",
            },
          ],
        },
      ],
      places: [
        pagesPlace([
          { title: "Waitlist page", sub: "Live preview · Coding" },
          { title: "Launch plan", sub: "Chief of Staff · yesterday" },
        ]),
        notesPlace([
          { title: "What 40 parents told us", sub: "Marketing · Monday" },
        ]),
        autoPlace([
          { title: "Weekly signups report", sub: "Mondays at 09:00" },
          { title: "Tell me if the page goes down", sub: "Always on" },
        ]),
        {
          id: "signups",
          name: "Waitlist signups",
          kind: "list",
          items: [
            { title: "212 signups", sub: "38 today" },
            { title: "Top source: parenting forum post", sub: "61%" },
          ],
        },
      ],
      decidedToday: 41,
      decided: [
        {
          what: "Kept Inter for the page, since you said no new fonts",
          who: "Coding",
          when: "11:40",
        },
        {
          what: "Send the launch email Tuesday 9:00, when parents open email most",
          who: "Marketing",
          when: "10:15",
        },
        {
          what: "Turned on double opt-in for the waitlist",
          who: "Ops",
          when: "09:30",
        },
      ],
      building: [
        { what: "Shrink the page's images", who: "Coding", mins: 12 },
        { what: "Load the font only where it's used", who: "Coding", mins: 4 },
        { what: "Tone pass on the launch email", who: "Marketing", mins: 9 },
      ],
      done: [
        { what: "Built the waitlist page", who: "Coding", when: "11:02" },
        { what: "Signup list with double opt-in", who: "Ops", when: "09:30" },
      ],
    },
    {
      id: "exo",
      name: "EXO",
      short: "EX",
      color: "#5B9CF5",
      autopilot: true,
      blurb: "An action game.",
      chat: [
        { from: "you", text: "Where are we on Area 3?" },
        {
          from: "cos",
          text: "The boss arena is half lit and dodge is moving to the right bumper, as you asked. Coding expects both today. Nothing needs you.",
        },
      ],
      mates: [
        mate(
          "coding",
          "Coding",
          "working",
          [],
          [
            { task: "Light the Area 3 boss arena", pct: 50, mins: 40 },
            { task: "Move dodge to the right bumper", pct: 80, mins: 25 },
          ],
        ),
        mate("design", "Design", "idle"),
      ],
      teams: [],
      places: [
        pagesPlace([{ title: "Area 3 map", sub: "Design · last week" }]),
        notesPlace([{ title: "Combat feel notes", sub: "You · Friday" }]),
      ],
      decidedToday: 96,
      decided: [
        {
          what: "Used the existing hit sound for the new combo",
          who: "Coding",
          when: "12:05",
        },
      ],
      building: [
        { what: "Light the Area 3 boss arena", who: "Coding", mins: 40 },
        { what: "Move dodge to the right bumper", who: "Coding", mins: 25 },
      ],
      done: [
        {
          what: "Fixed the camera clipping in Area 2",
          who: "Coding",
          when: "08:50",
        },
      ],
    },
    {
      id: "nibbii",
      name: "Nibbii",
      short: "NB",
      color: "#6CCB8F",
      autopilot: false,
      blurb: "A recipe app for kids.",
      chat: [
        {
          from: "cos",
          text: "Nibbii is resting while Autopilot is off. Tell me when you want it moving again.",
        },
      ],
      mates: [
        mate("coding", "Coding", "idle"),
        mate("marketing", "Marketing", "idle"),
      ],
      teams: [],
      places: [
        notesPlace([
          {
            title: "Recipe ideas from testers",
            sub: "Marketing · 2 weeks ago",
          },
        ]),
      ],
      decidedToday: 0,
      decided: [],
      building: [],
      done: [],
    },
    {
      id: "hivra",
      name: "Hivra",
      short: "HV",
      color: "#F0A35B",
      autopilot: true,
      blurb: "This app.",
      chat: [
        { from: "you", text: "Are builds still slow?" },
        {
          from: "cos",
          text: "At busy times they queue for about 20 minutes. A second build server is $40 a month, over your $20 limit, so I've asked you. My pick is to run big builds at night instead.",
          card: {
            title: "Spend $40 a month?",
            body: "In your questions, with my pick marked.",
            go: { to: "questions" },
          },
        },
      ],
      mates: [
        mate(
          "coding",
          "Coding",
          "working",
          [],
          [
            { task: "Make the sidebar remember its width", pct: 30, mins: 18 },
            { task: "Speed up opening a long chat", pct: 55, mins: 22 },
          ],
        ),
        mate(
          "ops",
          "Ops",
          "needs",
          [],
          [],
          [{ what: "Moved the nightly backup to 03:00" }],
        ),
      ],
      teams: [],
      places: [
        pagesPlace([{ title: "Roadmap", sub: "Chief of Staff · today" }]),
        autoPlace([{ title: "Nightly backup", sub: "Every day at 03:00" }]),
      ],
      decidedToday: 201,
      decided: [
        {
          what: "Moved the nightly backup to 03:00, when nobody's working",
          who: "Ops",
          when: "07:10",
        },
      ],
      building: [
        {
          what: "Make the sidebar remember its width",
          who: "Coding",
          mins: 18,
        },
        { what: "Speed up opening a long chat", who: "Coding", mins: 22 },
      ],
      done: [
        {
          what: "Fixed the settings page on small windows",
          who: "Coding",
          when: "10:30",
        },
      ],
    },
  ];
}

export function initialQuestions(): Question[] {
  return [
    {
      id: "q1",
      project: "safetube",
      ask: "Which headline for the waitlist page?",
      why: "Both tested about the same with 40 parents. It's a taste call, and it's public.",
      options: ["Video your kids can trust", "Safe videos, zero ads"],
      pick: 0,
    },
    {
      id: "q2",
      project: "hivra",
      ask: "Spend $40 a month on a second build server?",
      why: "Builds queue for about 20 minutes at busy times. Your limit without asking is $20 a month.",
      options: [
        "Yes, add it",
        "Not now, run big builds at night instead",
        "Ask me again next month",
      ],
      pick: 1,
    },
  ];
}

/** What the Chief of Staff (or a first mate) says back to a typed message. Example replies, nothing is sent. */
export function replyTo(
  text: string,
  speaker: string,
  projectName: string,
): string {
  const t = text.toLowerCase();
  if (/\b(status|update|how'?s|going|overnight|today)\b/.test(t))
    return `All moving in ${projectName}. Nothing new needs you since your last message; I'll put anything that does in your questions.`;
  if (/\b(stop|pause|hold)\b/.test(t))
    return "Done. I've paused that and told the crew. Say the word and I'll pick it back up.";
  if (/\?$/.test(t.trim()))
    return "Good question. I'll find out from the right first mate and come back to you here, usually within a few minutes.";
  if (speaker === "cos")
    return "Got it. I've handed that to the right first mate and it's on the Agents board. I'll tell you when it's done, and only ask you if it really needs you.";
  return "On it. I've put a crew member on it and I'll report back here and to the Chief of Staff when it's done.";
}
