import type { EventOf, GnomiEvent, Report, ReportTheme, UnmatchedEdit } from '../types.ts';
import { normaliseText } from './friction.ts';
import { themeByKeys } from './match.ts';
import type { RepeatSet } from './repeats.ts';
import { competitorsOf, latestByKeys, refOf, studyCount } from './study.ts';

// What a team changes before sharing a report (features_roadmap.md item 19). The report keeps what the run found, so the log stays
// truthful: only a copy for sharing applies the edits, and repeat sets, comparisons, the gate and every model read the originals.

export const EDIT_TITLE_MAX = 120;
export const EDIT_DESCRIPTION_MAX = 600;

const isHide = (e: GnomiEvent): e is EventOf<'finding.hidden'> => e.type === 'finding.hidden';
const isRewording = (e: GnomiEvent): e is EventOf<'finding.edited'> => e.type === 'finding.edited';

/** Every theme that shares a key with `ref`: themeByKeys names the best one at a time. */
function themesByKeys(ref: Parameters<typeof themeByKeys>[0], themes: ReportTheme[]): ReportTheme[] {
  const found: ReportTheme[] = [];
  for (let theme = themeByKeys(ref, themes); theme; theme = themeByKeys(ref, themes.filter((t) => !found.includes(t)))) found.push(theme);
  return found;
}

/**
 * Hands each theme its latest rewording and hide, matched as outcomes are (report/study.ts), and returns those with no theme left.
 * A rewording was written for one finding, so it takes one theme. A hide takes every part of a finding a rejudge split: a part left
 * over would be back in exports with nobody asking. It writes only the new fields, and nothing simulated reads them.
 */
export function foldEdits(events: GnomiEvent[], themes: ReportTheme[], setAside: ReportTheme[], tagged?: Map<string, string[]>): Pick<Report, 'unmatched_edits'> {
  const all = [...themes, ...setAside];
  const unmatched: UnmatchedEdit[] = [];
  const worded = new Set<ReportTheme>();
  for (const e of latestByKeys(events.filter(isRewording))) {
    const { title, new_title, new_description } = e.payload;
    const wording = new_title !== null || new_description !== null;
    const theme = themeByKeys(refOf(e), all.filter((t) => !worded.has(t)));
    if (theme) worded.add(theme);
    if (theme && wording) theme.edit = { hidden: false, new_title, new_description };
    if (!theme && wording) unmatched.push({ title, hidden: false, new_title, new_description });
  }
  const settled = new Set<ReportTheme>();
  for (const e of latestByKeys(events.filter(isHide))) {
    const parts = themesByKeys(refOf(e), all.filter((t) => !settled.has(t)));
    for (const theme of parts) {
      settled.add(theme);
      if (e.payload.hidden) (theme.edit ??= { hidden: false, new_title: null, new_description: null }).hidden = true;
    }
    // Two hidden findings a rejudge merged are one hidden finding, so the older hide has nothing to tell.
    if (e.payload.hidden && parts.length === 0 && !themeByKeys(refOf(e), all.filter((t) => t.edit?.hidden))) unmatched.push({ title: e.payload.title, hidden: true, new_title: null, new_description: null });
  }
  for (const theme of all.filter((t) => t.edit?.hidden)) {
    const members = new Set(theme.seqs);
    const posts = events.flatMap((e) => (e.type === 'social.post' && tagged?.get(e.payload.post_id)?.includes(theme.id) ? [e.seq] : []));
    const endings = events.flatMap((e) => (e.type === 'persona.abandoned' && e.persona_id && members.has(e.seq) ? [e.persona_id] : []));
    Object.assign(theme.edit!, { ...(posts.length > 0 && { posts }), ...(endings.length > 0 && { endings }) });
  }
  return unmatched.length > 0 ? { unmatched_edits: unmatched } : {};
}

const some = <T>(list: T[] | undefined) => (list?.length ? list : undefined);

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
  const renamed = new Map(titled.map((t) => [t.title, t.edit!.new_title!]));
  const unmatched_outcomes = some(report.unmatched_outcomes?.filter((o) => !hidden.some((t) => t.title === o.title)).map((o) => ({ ...o, title: renamed.get(o.title) ?? o.title })));

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
