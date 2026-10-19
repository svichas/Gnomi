import type { GnomiEvent, Report } from '../types.ts';
import type { Criterion, Mode } from './checks.ts';
import { M5_SEEDS, retask, withBuyers, type Fixture } from './fixture.ts';

/** The checkout sign-in prompt of Gym D26 is frame 4 of 6 (gym/defects.yaml `frames: [checkout/4]`), index 3. */
export const D26_FRAME = 3;
export const DESIGN_PERSONAS = 20; // the roadmap's demo script runs a frame sequence with 20 personas
export const SEEDS_NEEDED = 4; // of five

// The product and task each case gives the fixture's people. The buyers' task says what a buyer of a team plan needs; D28 is about exactly that.
const PRICING = { name: 'Plotline', description: 'Project planning for teams.', goal: 'Read the pricing page and work out which plan a team of 20 that needs single sign-on would use.' };
const BUYING = 'Decide which Plotline plan to buy for a team of 20 that needs single sign-on, and what it would cost.';
const CHECKOUT = { name: 'Fieldhouse', description: 'An online shop for outdoor clothing.', goal: 'Buy the rain jacket in your cart as a guest.' };

/** Gym v3's pricing copy as a text POI read by the fixture's people (users) and a buyer segment, one in five of them and at least three. */
export function textCase(base: Fixture, asset: string): Fixture {
  const data = withBuyers(retask(base, PRICING), Math.max(3, Math.round(base.personas.length / 5)), BUYING);
  return { ...data, project: { ...data.project, pois: [{ id: 'poi-pricing', type: 'text', name: 'Pricing page', segments: null, asset }] } };
}

/** Gym v3's checkout frames as a design POI, unnamed so a frame label gives nothing away, walked by the fixture's people. */
export function designCase(base: Fixture, assets: string[]): Fixture {
  const data = retask(base, CHECKOUT);
  return { ...data, project: { ...data.project, pois: [{ id: 'poi-checkout', type: 'design', name: 'Checkout', segments: null, frames: assets.map((asset) => ({ asset, name: null })) }] } };
}

export interface FrameMismatches { frame: number; reached: number; flagged: { persona_id: string; seq: number; what: string }[] }

/**
 * Who reported a friction on one frame of a finished design run. The design runner records every expectation mismatch as a friction on
 * the frame where it failed, so this reads the log alone. Null when the run did not finish.
 */
export function frameMismatches(events: GnomiEvent[], frame = D26_FRAME): FrameMismatches | null {
  if (!events.some((e) => e.type === 'run.finished')) return null;
  return {
    frame,
    reached: new Set(events.flatMap((e) => (e.type === 'persona.step' && e.payload.frame === frame ? [e.persona_id] : []))).size,
    flagged: events.flatMap((e) => (e.type === 'persona.friction_reported' && e.payload.frame === frame ? [{ persona_id: e.persona_id ?? '', seq: e.seq, what: e.payload.what }] : [])),
  };
}
const personas = (m: FrameMismatches) => new Set(m.flagged.map((f) => f.persona_id)).size;

/** Roadmap M5: the seeded mismatch is caught in at least four of five seeds. Missing seeds are undecided until the rest settle it. */
export function frameMismatchCriterion(mode: Mode, seeds: (FrameMismatches | null)[]): Criterion {
  const measured = seeds.filter((s) => s !== null);
  const wins = measured.filter((s) => s.flagged.length > 0).length;
  const losses = measured.length - wins;
  return {
    id: 'frame_mismatch', live_required: true,
    status: mode !== 'live' ? 'NOT_RUN' : wins >= SEEDS_NEEDED ? 'PASS' : losses > M5_SEEDS.length - SEEDS_NEEDED ? 'FAIL' : 'NOT_RUN',
    detail: `A friction landed on frame ${D26_FRAME + 1}, where D26 shows the sign-in prompt, in ${wins} of ${measured.length} measured seeds (${seeds.length - measured.length} missing); needs ${SEEDS_NEEDED} of ${M5_SEEDS.length}. Personas who reported it ÷ personas who reached the frame, per seed: ${seeds.map((s) => (s ? `${personas(s)}/${s.reached}` : 'missing')).join(', ')}.`,
  };
}

/** The control's frame 4 is the order confirmation, so a friction there may be a false positive; whether it is one is for a reader to say. */
export function controlFrameCriterion(mode: Mode, control: FrameMismatches | null): Criterion {
  const n = control && personas(control);
  return {
    id: 'design_control', live_required: true,
    status: mode !== 'live' || !control ? 'NOT_RUN' : n === 0 ? 'PASS' : 'REVIEW_NEEDED',
    detail: control ? `Control checkout, frame ${D26_FRAME + 1} (the order confirmation): ${n} of ${control.reached} personas who reached it reported a friction${n ? `, for example "${control.flagged[0].what}" (event ${control.flagged[0].seq})` : ''}; needs none.` : 'The control run did not finish.',
  };
}

/** The design case is refused by the design runner's preflight (a navigator that cannot see images): nothing runs and nothing is spent. */
export const designSkipped = (reason: string): Criterion[] => (['frame_mismatch', 'design_control'] as const).map((id) => ({ id, status: 'NOT_RUN', live_required: true, detail: `Design case not run: ${reason}` }));

/** A pass or a fail needs the roadmap's scale; a smaller run keeps its figures and says so. A reviewer's call stays one. */
export const atScale = (criterion: Criterion, reduced: string | null): Criterion =>
  reduced ? { ...criterion, status: criterion.status === 'REVIEW_NEEDED' ? 'REVIEW_NEEDED' : 'NOT_RUN', detail: `Reduced scale (${reduced}): ${criterion.detail}` } : criterion;

type TextReport = Pick<Report, 'status' | 'segments' | 'sentiment' | 'buyers' | 'themes'>;

/**
 * Roadmap M5: the pricing-page run with a buyer segment has a sentiment for every segment, the buyers' answers, and a ranked list of
 * confusions of which some quote the text. Structural, so a rehearsal checks it too, but only a live run can pass.
 */
export function buyerTextCriterion(mode: Mode, report: TextReport | undefined): Criterion {
  const id = 'buyer_text';
  if (report?.status !== 'finished') return { id, status: 'NOT_RUN', live_required: true, detail: 'The pricing-page run with D28 did not finish.' };
  const sentiment = new Map((report.sentiment ?? []).map((s) => [s.segment_id, s]));
  const buyers = (report.buyers ?? []).filter((b) => b.surveyed > 0);
  // Users' sentiment is by segment; a buyer segment's is in its buying survey.
  const unrated = report.segments.filter((s) => (!sentiment.get(s.id)?.surveyed || sentiment.get(s.id)?.sentiment == null) && !buyers.some((b) => b.segment_id === s.id)).map((s) => s.name);
  const themes = report.themes ?? [];
  const quoted = themes.filter((t) => t.evidence.some((e) => e.passage?.text));
  const problems = [
    ...(unrated.length ? [`no sentiment for ${unrated.join(', ')}`] : []),
    ...(buyers.length ? [] : ['no buying survey answers']),
    ...(themes.length ? [] : ['no confusions']),
    ...(themes.map((t) => t.rank).sort((a, b) => a - b).every((rank, i) => rank === i + 1) ? [] : ['confusion ranks are not 1…n']),
    ...(quoted.length ? [] : ['no confusion quotes a passage of the text']),
  ];
  return {
    id, live_required: true, status: mode !== 'live' ? 'NOT_RUN' : problems.length ? 'FAIL' : 'PASS',
    detail: problems.length ? `Missing: ${problems.join('; ')}.` : `Sentiment for all ${report.segments.length} segments, buying survey answers from ${buyers.map((b) => b.name).join(', ')}, ${themes.length} ranked confusions of which ${quoted.length} quote a passage of the text.`,
  };
}

/** Whether a theme describes D28 (and whether the control produces one like it) is a reader's judgment; this only says when the sheet is ready. */
export function d28Criterion(mode: Mode, runs: { d28?: Pick<Report, 'status'>; control?: Pick<Report, 'status'> }): Criterion {
  const ready = mode === 'live' && runs.d28?.status === 'finished' && runs.control?.status === 'finished';
  return {
    id: 'd28_theme', live_required: true, status: ready ? 'REVIEW_NEEDED' : 'NOT_RUN',
    detail: 'Record in d28-themes.json whether a theme of the D28 run describes the SSO contradiction (Team lists SSO; the table and FAQ give it to Business only), and that no theme of the control run does. Text themes are self-reports, so none can be confirmed or observed.',
  };
}

export const FIGMA_LISTING: Criterion = {
  id: 'figma_listing', status: 'NOT_RUN', live_required: true,
  detail: 'Not measured by this runner. app/figma.smoke.ts (npm run smoke:figma -w @gnomi/app) lists 50 frames in under ten seconds and shows the token messages against the fixture API; a real file needs a Figma personal access token and a manual check.',
};
