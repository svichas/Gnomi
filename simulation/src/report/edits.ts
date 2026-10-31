import type { EventOf, GnomiEvent, Report, ReportTheme, UnmatchedEdit, UnmatchedOutcome } from '../types.ts';
import { normaliseText } from './friction.ts';
import { themeByKeys } from './match.ts';
import type { RepeatSet } from './repeats.ts';
import { competitorsOf, latestByKeys, refOf, studyCount } from './study.ts';

// What a team changes before sharing a report (features_roadmap.md item 19). The report keeps what the run found, so the log stays
// truthful: only a copy for sharing applies the edits, and repeat sets, comparisons, the gate and every model read the originals.

export const EDIT_TITLE_MAX = 120;
export const EDIT_DESCRIPTION_MAX = 600;
export const EDIT_WARNING = "Leave out names and contact details. A rewording stays in this project's log, even after a reset, and appears in exports.";

const isHide = (e: GnomiEvent): e is EventOf<'finding.hidden'> => e.type === 'finding.hidden';
const isRewording = (e: GnomiEvent): e is EventOf<'finding.edited'> => e.type === 'finding.edited';

/**
 * Hands each theme its latest rewording and hide, by keys as outcomes are matched (report/study.ts), and returns the edits that share a
 * key with no theme at all. One that overlaps a theme is settled there, so a team that undid it is not told to check it.
 * A rewording was written for one finding, so it goes to the theme it fits best. A newer record on that theme, a reset included, replaces
 * it, and its words do not move to another part of a split finding. A hide holds key by key, the latest record naming a key deciding, and
 * one hidden key hides its theme: a part left over would be back in exports with nobody asking. It writes only the new fields, and
 * nothing simulated reads them.
 */
export function foldEdits(events: GnomiEvent[], themes: ReportTheme[], setAside: ReportTheme[], tagged?: Map<string, string[]>): Pick<Report, 'unmatched_edits'> {
  const all = [...themes, ...setAside];
  const unmatched: UnmatchedEdit[] = [];
  const worded = new Set<ReportTheme>();
  for (const e of latestByKeys(events.filter(isRewording))) {
    const { title, new_title, new_description } = e.payload;
    const wording = new_title !== null || new_description !== null;
    const theme = themeByKeys(refOf(e), all);
    if (!theme && wording) unmatched.push({ title, hidden: false, new_title, new_description });
    if (!theme || worded.has(theme)) continue;
    worded.add(theme);
    if (wording) theme.edit = { hidden: false, new_title, new_description };
  }
  const hides = events.filter(isHide);
  const hiddenKeys = new Map(hides.flatMap((e) => e.payload.keys.map((key) => [key, e.payload.hidden] as const)));
  for (const theme of all) if (theme.keys?.some((key) => hiddenKeys.get(key))) (theme.edit ??= { hidden: false, new_title: null, new_description: null }).hidden = true;
  for (const e of latestByKeys(hides)) if (e.payload.hidden && !themeByKeys(refOf(e), all)) unmatched.push({ title: e.payload.title, hidden: true, new_title: null, new_description: null });
  for (const theme of all.filter((t) => t.edit?.hidden)) {
    const members = new Set(theme.seqs);
    const posts = events.flatMap((e) => (e.type === 'social.post' && tagged?.get(e.payload.post_id)?.includes(theme.id) ? [e.seq] : []));
    const endings = events.flatMap((e) => (e.type === 'persona.abandoned' && e.persona_id && members.has(e.seq) ? [e.persona_id] : []));
    Object.assign(theme.edit!, { ...(posts.length > 0 && { posts }), ...(endings.length > 0 && { endings }) });
  }
  return unmatched.length > 0 ? { unmatched_edits: unmatched } : {};
}

const some = <T>(list: T[] | undefined) => (list?.length ? list : undefined);

/** The finding of `themes` an outcome left over from a rejudge touches. Its title dates from when it was recorded, so keys come first; a title alike is the same words, and all an older report has. */
const touches = (outcome: UnmatchedOutcome, themes: ReportTheme[]) => themeByKeys(outcome, themes) ?? themes.find((t) => t.title === outcome.title);

/**
 * The copy of a report for sharing: hidden findings gone from everything that names them, reworded ones in the team's words and marked,
 * and `shared` saying how many of each. Pure. A report with no edit comes back as it was. Coverage, flows, reach and the rates hold only
 * pages and numbers from the run, which stay. A step's thought that is also evidence for a kept finding loses that quote, as it is the
 * hidden finding's too; a persona's words outside these fields can still touch the same problem.
 */
export function forSharing(report: Report): Report {
  const { unmatched_edits: _, ...copy } = report;
  const all = [...(report.themes ?? []), ...(report.set_aside ?? [])];
  const hidden = all.filter((t) => t.edit?.hidden);
  const worded = all.filter((t) => t.edit && !t.edit.hidden);
  if (hidden.length + worded.length === 0) return copy;

  const left = (t: ReportTheme) => !t.edit?.hidden;
  const members = new Set(hidden.flatMap((t) => t.seqs));
  const quotes = new Set(hidden.flatMap((t) => t.evidence.flatMap((e) => (e.quote ? [e.quote] : []))));
  const unquoted = <T extends { quote: string }>(item: T): T => (quotes.has(item.quote) ? { ...item, quote: '' } : item);
  const share = ({ edit, ...theme }: ReportTheme): ReportTheme => {
    const evidence = theme.evidence.map(unquoted);
    if (!edit) return { ...theme, evidence };
    const title = edit.new_title ?? theme.title;
    return { ...theme, evidence, title, description: edit.new_description ?? theme.description, reworded: true, ...(edit.new_title !== null && theme.validation && { validation: { ...theme.validation, title } }) };
  };
  const themes = report.themes?.filter(left).map(share);
  const set_aside = some(report.set_aside?.filter(left).map(share));

  const titled = worded.filter((t) => t.edit?.new_title);
  const titleOf = new Map(titled.map((t) => [t.id, t.edit!.new_title!]));
  const plan = report.study_plan;
  const study_plan = plan && { ...plan, hypotheses: plan.hypotheses.filter((h) => !themeByKeys(h, hidden)).map((h) => ({ ...h, title: themeByKeys(h, titled)?.edit?.new_title ?? h.title })) };
  const studied = [...(themes ?? []), ...(set_aside ?? [])].some((t) => t.validation);
  const study_count = report.study_count && studied ? studyCount(themes ?? [], competitorsOf(report)) : undefined;
  const unmatched_outcomes = some(report.unmatched_outcomes?.filter((o) => !touches(o, hidden)).map((o) => ({ ...o, title: touches(o, titled)?.edit?.new_title ?? o.title })));

  const posts = new Set(hidden.flatMap((t) => t.edit?.posts ?? []));
  const unposted = <T extends { seeds: { seq: number }[] }>(stats: T): T => ({ ...stats, seeds: stats.seeds.filter((post) => !posts.has(post.seq)) });
  const spread = report.spread?.map((poi) => unposted({
    ...poi,
    themes: poi.themes.filter((t) => !hidden.some(({ id }) => id === t.theme_id)).map((t) => unposted({ ...t, title: titleOf.get(t.theme_id) ?? t.title })),
  }));
  const keys = new Set(hidden.flatMap((t) => t.keys ?? []));
  const buyers = report.buyers?.map((row) => ({ ...row, objections: row.objections.filter((o) => !keys.has(JSON.stringify([row.poi_id, null, 'objection', normaliseText(o.text)]))) }));
  const endings = new Set(hidden.flatMap((t) => t.edit?.endings ?? []));

  return {
    ...copy,
    themes,
    set_aside,
    study_plan,
    study_count,
    unmatched_outcomes,
    spread,
    buyers,
    personas: report.personas.map((p) => (endings.has(p.id) ? { ...p, outcome_text: null } : p)),
    frictions: report.frictions.filter((f) => !members.has(f.seq)).map(unquoted),
    shared: { hidden: hidden.length, reworded: worded.length },
  };
}

/** A set as a copy for sharing reads it, given the report before that copy: a reworded finding's own title would come back as what other runs named it. */
export function setForSharing(set: RepeatSet, report: Report): RepeatSet {
  const original = new Map((report.themes ?? []).flatMap((t) => (t.edit?.new_title ? [[t.id, t.title] as const] : [])));
  return { ...set, findings: set.findings.map((f) => ({ ...f, titles: f.titles.filter((title) => title !== original.get(f.themes[report.run_id])) })) };
}
