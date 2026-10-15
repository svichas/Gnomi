// Deterministic and schema-valid, and every text says no model wrote it; the fixed name lists stand in for trait-derived names.
import type { LlmRequest, Responder } from '../seams.ts';
import type { Persona } from '../types.ts';
import { LOGINS_LABEL, type Proposal } from './propose.ts';
import { fnv1a, mulberry32, type Traits } from './sample.ts';
import { languageName, nameKey, TAKEN_LABEL, TRAITS_LABEL, type Candidate } from './write.ts';

const FIRST: Record<Persona['pronouns'], string[]> = {
  she: ['Amara', 'Lucía', 'Mei', 'Priya', 'Hannah', 'Fatima', 'Ingrid', 'Chloé', 'Ana', 'Yuki', 'Zainab', 'Olga', 'Grace', 'Leila', 'Sofia', 'Nadia', 'Rosa', 'Ewa', 'Thandiwe', 'Camille', 'Meera', 'Isabel', 'Aroha', 'Sun-hee'],
  he: ['Kwame', 'Mateo', 'Wei', 'Arjun', 'Lukas', 'Omar', 'Tomás', 'Kenji', 'Daniel', 'Emeka', 'Pierre', 'Rahul', 'Mikhail', 'Jonas', 'Diego', 'Hassan', 'Ravi', 'Samuel', 'Bartek', 'Tariq', 'Henrik', 'Jae-won', 'Luca', 'Marcus'],
  they: ['Alex', 'Robin', 'Sam', 'Jordan', 'Kai', 'Noor', 'Rowan', 'Ari', 'Quinn', 'Sasha', 'Eden', 'Remy'],
};
const SURNAMES = ['Okafor', 'García', 'Chen', 'Natarajan', 'Müller', 'Haddad', 'Johansson', 'Dubois', 'Silva', 'Tanaka', 'Mensah', 'Kowalczyk', 'Novak', 'Reyes', 'Kim', 'Nguyen', "O'Brien", 'Patel', 'Rossi', 'Schmidt', 'Ahmed', 'Costa', 'Fischer', 'Hughes', 'Ibrahim', 'Jensen', 'Kaya', 'López', 'Mbeki', 'Nakamura', 'Owusu', 'Park', 'Quispe', 'Rahman', 'Santos', 'Takahashi', 'Usman', 'Varga', 'Walsh', 'Yilmaz', 'Zhang', 'Adeyemi', 'Bianchi', 'Castillo', 'Dlamini', 'Eriksen', 'Farouk', 'Gupta'];
const TITLES: Record<Persona['seniority'], string[]> = {
  junior: ['Coordinator', 'Assistant', 'Associate', 'Trainee'],
  mid: ['Specialist', 'Analyst', 'Officer', 'Consultant'],
  senior: ['Senior specialist', 'Senior analyst', 'Manager', 'Senior consultant'],
  lead: ['Team lead', 'Head of operations', 'Director', 'Department head'],
};
const INDUSTRIES = ['regional logistics', 'hospital administration', 'retail banking', 'construction', 'higher education', 'software', 'hospitality', 'food manufacturing', 'public transport', 'insurance', 'renewable energy', 'legal services', 'e-commerce', 'pharmaceuticals', 'telecoms', 'nonprofit fundraising'];
const ORIGINS = [
  'a job I fell into after a temporary contract turned permanent',
  'which I joined after six years somewhere much bigger',
  'where I moved over from operations when the role opened up',
  'my first job after finishing my degree',
  'where I came back after two years of freelancing',
  'where a friend recommended me when the team grew quickly',
  'which I joined after switching careers from teaching',
  'where I have been longer than most of the furniture',
];
const WEEKS = [
  'Most weeks are a mix of meetings, catch-up email and one urgent thing nobody planned for.',
  'Mondays are for planning; the rest of the week disappears into requests from other teams.',
  'My days follow a checklist, and I like tools that respect it.',
  'I juggle several projects at once and lose track when a tool hides where I left off.',
  'Much of my week goes on copying things between systems that should talk to each other.',
  'I spend half my time travelling and the other half catching up.',
  'Quiet mornings are for focused work; afternoons belong to everybody else.',
  'I work part time, so every wasted minute comes out of something else.',
];
const PET_HATES = [
  'What I will not put up with is losing work because a page timed out.',
  'I have no patience for tools that make me confirm the same thing twice.',
  'Jargon-heavy screens make me close the tab.',
  'Hunting for the save button wears me down.',
  'If a tool sends five notifications for one change, I mute it forever.',
  'Slow pages drive me up the wall, especially on hotel wifi.',
  'Anything that needs a training video loses me.',
  'Forms that wipe my answers after an error are my pet hate.',
];
const TOOLS = [
  'We run most of it on spreadsheets and a shared inbox.',
  'Our current system is fifteen years old and everyone has a workaround for it.',
  'I live in chat threads, and anything not linked from one gets forgotten.',
  'We switched tools last year and I still miss a couple of things about the old one.',
  'Half the team uses the official tool and half keeps private notes.',
  'Everything I do ends up in a weekly report for my manager.',
  'A paper notebook sits next to my keyboard because I trust it more than any app.',
  'Our IT department locks most settings, so I take software as it comes.',
];
const DEVICES: Record<Persona['device'], string[]> = {
  mobile: [
    'I do most of this on my phone, usually in between other things.',
    'My phone is where I handle anything not urgent enough for the laptop.',
    'I am rarely at a desk, so my phone is my office.',
    'I check work on my phone during the commute and at lunch.',
  ],
  desktop: [
    'I work at a desk with a big screen and too many tabs open.',
    'I sit at a laptop most of the day, a spreadsheet open next to everything else.',
    'My desk has two monitors and a pile of sticky notes.',
    'I work from a laptop at home three days a week.',
  ],
};
const SKILLS = {
  low: ['I stick to the buttons I know and ask a colleague when something changes.', 'New software makes me nervous until someone walks me through it.'],
  mid: ['I get by with most software once someone shows me where things are.', 'I can find my way around most apps, given a minute to look.'],
  high: ['People ask me when software misbehaves, and I usually find a way around it.', 'I try keyboard shortcuts first and read release notes for fun.'],
};
const PATIENCE = {
  low: [' When something wastes my time I drop it and find another way.', ' I give a tool one chance; if it trips me up, I move on.'],
  high: [' I try a few things before I give up on a tool.', ' I am stubborn with software and usually get there in the end.'],
};
const CONTEXTS: Record<Persona['device'], string[]> = {
  mobile: ['On a phone between two meetings, with a few minutes to spare (scripted demo).', 'On a phone on the train home, one-handed (scripted demo).'],
  desktop: ['At a desk mid-morning, between two other tasks (scripted demo).', 'At a laptop late in the afternoon, twenty tabs open (scripted demo).'],
};
const ACCESS: Record<Persona['accessibility_needs'], string> = {
  none: '',
  low_vision: ' I keep my browser zoomed to 150 percent and still lean in to read small text.',
  colour_blind: ' I cannot tell red from green, so colour-only warnings pass me by.',
  screen_reader: ' I use a screen reader for everything, so unlabelled buttons are a dead end for me.',
  motor: ' Small targets are hard for me to hit, so I use the keyboard wherever I can.',
};
function proposal(roles: string[]): Proposal {
  const role = (i: number) => roles[i] ?? roles[0] ?? null;
  const segment = { patience_min: 1, patience_max: 4, account_state: 'populated', entry: 'direct', goal_override: null } as const;
  return {
    segments: [
      {
        ...segment,
        name: 'Everyday users',
        description: 'Scripted demo segment, no model ran: people who use the product every day as part of their job.',
        share: 60,
        role: role(0),
        usage_frequency: 'daily',
        mobile_share: 0.15,
        patience_min: 2,
        tech_skill_min: 2,
        tech_skill_max: 5,
        typical_goals: ['Get the routine work of the day done', 'Check what changed since yesterday'],
      },
      {
        ...segment,
        name: 'Occasional users',
        description: 'Scripted demo segment, no model ran: people who open the product now and then, usually because someone asked them to.',
        share: 30,
        role: role(1),
        usage_frequency: 'monthly',
        mobile_share: 0.5,
        patience_max: 3,
        tech_skill_min: 2,
        tech_skill_max: 4,
        entry: 'email_link',
        typical_goals: ['Answer a request from a colleague', 'Find one thing and get out'],
      },
      {
        ...segment,
        name: 'Newcomers',
        description: 'Scripted demo segment, no model ran: people trying the product for the first time.',
        share: 10,
        role: null,
        usage_frequency: 'never',
        mobile_share: 0.35,
        tech_skill_min: 1,
        tech_skill_max: 4,
        account_state: 'empty',
        entry: 'shared_link',
        typical_goals: ['See what the product does', 'Decide whether it is worth their time'],
      },
    ],
  };
}

function candidates(t: Traits, taken: string[], seed: number): { candidates: Candidate[] } {
  const rng = mulberry32(seed);
  const one = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)];
  const avoid = new Set(taken.map(nameKey));
  const language = languageName(t.language);
  const out: Candidate[] = [];
  for (let attempt = 0; out.length < 4; attempt++) {
    const name = `${one(FIRST[t.pronouns])} ${one(SURNAMES)}`;
    if (avoid.has(nameKey(name)) && attempt < 200) continue;
    avoid.add(nameKey(name));
    const title = one(TITLES[t.seniority]);
    const industry = one(INDUSTRIES);
    const skill = one(SKILLS[t.tech_skill <= 2 ? 'low' : t.tech_skill === 3 ? 'mid' : 'high']);
    const patience = t.patience <= 2 ? one(PATIENCE.low) : t.patience >= 4 ? one(PATIENCE.high) : '';
    const lang = t.language === 'en' ? '' : ` My first language is ${language}; I read English at work every day but think in ${language}.`;
    out.push({
      name,
      job_title: title,
      industry,
      background:
        `I am ${/^[aeiou]/i.test(title) ? 'an' : 'a'} ${title.toLowerCase()} at a ${t.company_size.toLocaleString('en-US')}-person ${industry} company, ${one(ORIGINS)}. ` +
        (t.employer ? `My employer is ${t.employer}. ` : '') + (t.city ? `I live in ${t.city}. ` : '') +
        `${one(WEEKS)} ${one(TOOLS)} ${one(DEVICES[t.device])} ${skill}${ACCESS[t.accessibility_needs]}${lang} ${one(PET_HATES)}${patience} ` +
        '(Scripted demo persona: no model wrote this.)',
      context_of_use: one(CONTEXTS[t.device]),
      goal_interpretation:
        t.motivation <= 2
          ? 'Scripted demo, no model read the task: do the minimum it asks and move on.'
          : t.motivation >= 4
            ? 'Scripted demo, no model read the task: do it properly, since it matters for my work.'
            : 'Scripted demo, no model read the task: get it done without fuss.',
      voice: `Scripted demo voice, no model wrote it: ${t.patience <= 2 ? 'short and blunt' : t.patience >= 4 ? 'calm and thorough' : 'plain and practical'}; thinks in ${language}.`,
      probability: [0.4, 0.3, 0.2, 0.1][out.length],
    });
  }
  return { candidates: out };
}

function line(text: string, label: string): unknown {
  const found = text.split('\n').find((l) => l.startsWith(label));
  return found === undefined ? undefined : JSON.parse(found.slice(label.length));
}

/** Scripted persona_writer answers (proposal and write-ups) for tests and GNOMI_FAKE_LLM. */
export const DEMO_PERSONA_WRITER: Responder = (req: LlmRequest<unknown>) => {
  const text = req.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  if (req.purpose === 'propose_audience') return proposal((line(text, LOGINS_LABEL) as string[] | undefined) ?? []);
  if (req.purpose === 'write_persona') {
    const traits = line(text, TRAITS_LABEL) as Traits | undefined;
    if (!traits) throw new Error('DEMO_PERSONA_WRITER: the request has no sampled traits');
    return candidates(traits, (line(text, TAKEN_LABEL) as string[] | undefined) ?? [], fnv1a(`${req.persona_id}/${JSON.stringify(traits)}`));
  }
  throw new Error(`DEMO_PERSONA_WRITER has no scripted answer for purpose ${req.purpose}`);
};
