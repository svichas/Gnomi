import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ProjectInfo } from '@gnomi/engine/protocol.ts';
import { loginPoi, webPois } from '@gnomi/simulation/poi/pois.ts';
import type { LlmRole, ProjectConfig, RunEstimate } from '@gnomi/simulation/types.ts';
import { socialRounds } from '@gnomi/simulation/settings.ts';
import { PROVIDER_LABELS } from '../../providers.ts';
import { AudienceSteps } from './Audience.tsx';
import { estimateText } from './cost.ts';
import { call, errorText } from './engine.ts';
import { problemFor, rolesInUse, startHost } from './form.ts';
import { Icon } from './Icon.tsx';
import { RecordingPanel, useRecorder } from './Recorder.tsx';
import { ROLE_TEXT } from './Settings.tsx';
import { ActionBar, Button, Check, Note, usd, useAction } from './ui.tsx';

type Login = 'checking' | { ok: boolean; reason: string | null };
export type ReviewScreen = 'project' | 'audience' | 'settings';

function Section({ title, edit, wide, children }: { title: string; edit: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className={`content-panel review-card ${wide ? 'review-wide' : ''}`}>
      <div className="review-card-head"><h2>{title}</h2>{edit}</div>
      <dl className="review-facts">{children}</dl>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The third step, the last stop before a run: what will run, anything to fix first, and the logins and estimate, checked now.
 * App saves the project on the way here and remounts this for every visit, so the checks always describe what will start.
 */
export function Review(props: {
  config: ProjectConfig | string; // the saved project, or why it could not be saved
  info: ProjectInfo | null;
  onFix(screen: ReviewScreen): void;
  onBack(): void;
  onRecheck(): void;
  onChecked(): Promise<void>;
  onStarted(runId: string): void;
  onSocial(on: boolean): void; // saves the setting and checks again, as the estimate changes
}) {
  const { config, info, onFix, onBack, onRecheck, onChecked, onStarted, onSocial } = props;
  const saved = typeof config === 'string' ? null : config;
  const roles = saved ? rolesInUse(saved) : [];
  const [reset, setReset] = useState(false);
  const [logins, setLogins] = useState<Record<string, Login>>(() => Object.fromEntries(roles.map((role) => [role, 'checking' as const])));
  const [estimate, setEstimate] = useState<RunEstimate | { error: string } | null>(null);
  const { busy, outcome, run } = useAction();
  const recorder = useRecorder(async () => {
    await onChecked();
    onRecheck(); // a new login: save and check everything again
  });
  const personas = info?.personas ?? [];

  useEffect(() => {
    if (!saved) return;
    let current = true;
    for (const role of roles) {
      call('check_session', { role }).then(
        (checked) => {
          if (!current) return;
          setLogins((was) => ({ ...was, [role]: checked }));
          void onChecked(); // a good check updates when the login was last verified
        },
        (err) => current && setLogins((was) => ({ ...was, [role]: { ok: false, reason: errorText(err) } })),
      );
    }
    call('estimate_run', {}).then(
      (result) => current && setEstimate(result),
      (err) => current && setEstimate({ error: errorText(err) }),
    );
    return () => {
      current = false;
    };
  }, []);

  const start = () =>
    run(async () => {
      const { run_id } = await call('start_run', { reset });
      onStarted(run_id);
      return null;
    });

  const fix = (screen: ReviewScreen, label: string) => <Button variant="link" onClick={() => onFix(screen)}>{label}<Icon name="arrow" size={14} /></Button>;

  // Blocking issues first: each says what is wrong and offers the way to fix it. Start stays off while any remain, as the engine would refuse.
  const issues: { text: string; blocking: boolean; action: ReactNode }[] = [];
  if (typeof config === 'string') {
    const screen: ReviewScreen = config.startsWith('Settings: ') ? 'settings' : config.startsWith('Audience: ') ? 'audience' : 'project';
    issues.push({ text: problemFor(config, screen), blocking: true, action: fix(screen, { project: 'Fix in Setup', audience: 'Fix in Audience', settings: 'Fix in Settings' }[screen]) });
  }
  if (saved?.audience && personas.length === 0) issues.push({ text: 'Your audience has no personas yet. Generate them before starting a run.', blocking: true, action: fix('audience', 'Generate personas') });
  for (const role of roles) {
    const login = logins[role];
    if (login === 'checking' || login === undefined || login.ok) continue;
    issues.push({
      text: `The recorded ${role} login no longer works${login.reason ? `: ${login.reason}` : '.'}`,
      blocking: true,
      action: <Button onClick={() => void recorder.start(role)} disabled={recorder.busy || recorder.recording !== null} small>Re-record {role} login</Button>,
    });
  }
  if (estimate && 'error' in estimate) issues.push({ text: `No estimate: ${estimate.error}`, blocking: true, action: null });
  else if (estimate && estimate.unpriced.length > 0) issues.push({ text: `No price is known for ${estimate.unpriced.join(', ')}. Choose a model with a known price before starting.`, blocking: true, action: fix('settings', 'Choose models') });
  else if (saved && estimate && estimate.cost_usd[1] > saved.settings.cost_budget_usd) issues.push({ text: 'The estimate may be more than your budget, so the run could stop early.', blocking: false, action: fix('settings', 'Adjust budget') });
  const blocking = issues.filter((issue) => issue.blocking).length;
  const ready = saved !== null && estimate !== null && blocking === 0;

  const status = !saved ? 'Fix the problem above to continue.' : estimate === null ? 'Checking logins and the estimate…' : blocking ? `${blocking} ${blocking === 1 ? 'thing' : 'things'} to fix before starting.` : 'Everything is in place.';

  return (
    <div className="review-page">
      {saved?.audience && <AudienceSteps stage={3} />}
      {issues.length > 0 && (
        <section aria-labelledby="review-issues-title" className="review-issues" data-blocking={blocking > 0 || undefined}>
          <h2 id="review-issues-title">{blocking ? 'Fix before you start' : 'Worth a look'}</h2>
          <ul>
            {issues.map((issue) => (
              <li key={issue.text}>
                <span className={issue.blocking ? 'review-issue-blocking' : 'review-issue-warning'}><Icon name="alert" size={18} /></span>
                <p>{issue.text}</p>
                {issue.action}
              </li>
            ))}
          </ul>
        </section>
      )}
      <RecordingPanel recorder={recorder} />
      {recorder.outcome && <Note tone={recorder.outcome.ok ? 'ok' : 'error'}>{recorder.outcome.text}</Note>}
      {ready && (
        <div className="review-ready">
          <span className="audience-next-icon"><Icon name="check" size={24} /></span>
          <div><h2>Ready when you are.</h2><p>Your simulated users will try {new Intl.ListFormat('en').format(saved.pois.map((poi) => poi.name))}. Start the run, then follow their experience as it unfolds.</p></div>
        </div>
      )}

      {saved && <div className="review-grid">
        <Section title="What they will try" edit={fix('project', 'Edit setup')}>
          <Fact label="Goal">{saved.goal}</Fact>
          {saved.description && <Fact label="The product">{saved.description}</Fact>}
          {saved.pois.length > 1 && <Fact label="Points of interest, in order">{saved.pois.map((poi) => <span key={poi.id} className="block">{poi.name}</span>)}</Fact>}
          {webPois(saved.pois).length > 0 && <Fact label="Start pages">
            {webPois(saved.pois).flatMap((poi) => poi === loginPoi(saved.pois)
              ? [...roles.map((role) => `${role}: ${info?.sessions.find((session) => session.role === role)?.start_url ?? poi.start_url}`), ...(loggedOut(saved) ? [`logged out: ${poi.start_url}`] : [])]
              : [`${poi.name}: ${poi.start_url}`]).map((page) => <span key={page} className="block break-all">{page}</span>)}
          </Fact>}
        </Section>

        <Section title="Who will browse" edit={fix('audience', 'Edit audience')}>
          {saved.audience ? (
            <>
              <Fact label="People">{personas.length} simulated {personas.length === 1 ? 'person' : 'people'}</Fact>
              <Fact label="Segments">
                <ul className="review-segments">
                  {saved.audience.segments.map((segment, index) => {
                    const count = personas.filter((persona) => persona.segment_id === segment.id).length;
                    return (
                      <li key={segment.id} style={{ '--segment-color': `var(--gnomi-segment-${index % 5 + 1})` } as CSSProperties}>
                        <span className="segment-dot" />
                        <span><strong>{segment.name || 'Unnamed segment'}</strong> {count} {count === 1 ? 'persona' : 'personas'} · {segment.share}% · {segment.role ? `${segment.role} login` : 'logged out'}</span>
                      </li>
                    );
                  })}
                </ul>
              </Fact>
            </>
          ) : (
            <Fact label="People">{info?.persona ? `${info.persona.name}, ${info.persona.job_title} (the built-in persona)` : 'One built-in persona'}</Fact>
          )}
          <Fact label="Social rounds">
            {saved.audience ? (
              <>
                <Check checked={saved.settings.social ?? false} onChange={onSocial}>Let personas interact in a shared feed</Check>
                <span className="block pl-6 text-xs text-stone-500">
                  {socialRounds(saved.settings, saved.audience)
                    ? `${socialRounds(saved.settings, saved.audience)} rounds: each persona uses the product for a while, then reads posts from the people it follows and may post, reply or react. Change the number of rounds on the Audience step.`
                    : 'Off: each persona tries the product on its own.'}
                </span>
              </>
            ) : 'Off: the built-in persona runs alone.'}
          </Fact>
        </Section>

        <Section title="Cost and time" edit={fix('settings', 'Edit budgets')}>
          <Fact label="Estimate">
            {estimate === null ? 'Working it out…' : 'error' in estimate ? 'No estimate.' : estimate.unpriced.length > 0 ? 'No estimate until every model has a price.' : `${estimateText(estimate)}, about ${estimate.calls.toLocaleString()} model calls.`}
          </Fact>
          <div className="review-fact-row">
            <Fact label="Cost limit">{usd(saved.settings.cost_budget_usd)}</Fact>
            <Fact label="Time limit">{saved.settings.wall_clock_budget_min} minutes</Fact>
            <Fact label="Browsers at once">{saved.settings.concurrency}</Fact>
          </div>
          <p className="review-note">At the cost limit, new work stops and outstanding model requests are canceled. Browser actions already started can finish. Providers may still charge for requests in flight, so billed cost can exceed the limit. Persona generation is charged separately.</p>
        </Section>

        <Section title="Models" edit={fix('settings', 'Edit models')}>
          {(['navigator', ...(socialRounds(saved.settings, saved.audience) ? ['socialiser' as const] : []), 'judge', 'author'] satisfies LlmRole[]).map((role) => (
            <Fact key={role} label={ROLE_TEXT[role].label}>{PROVIDER_LABELS[saved.settings.routing[role].provider]} · {saved.settings.routing[role].model}</Fact>
          ))}
        </Section>

        <Section title="Where they can go" edit={fix('project', 'Edit access')} wide>
          <div className="review-fact-row">
            <Fact label="Logins">
              {roles.length === 0 && 'None: the personas browse logged out.'}
              {roles.map((role) => {
                const login = logins[role];
                return <span key={role} className="block">{login === 'checking' || login === undefined ? `Checking the recorded ${role} login…` : login.ok ? `The recorded ${role} login works.` : `The recorded ${role} login no longer works.`}</span>;
              })}
              {roles.length > 0 && loggedOut(saved) && <span className="block text-stone-600">The other personas browse logged out.</span>}
            </Fact>
            {webPois(saved.pois).map((poi, _, all) => {
              const of = all.length > 1 ? ` (${poi.name})` : '';
              return [
                <Fact key={`${poi.id}-hosts`} label={`Allowed hosts${of}`}>{[startHost(poi.start_url) ?? poi.start_url, ...poi.allowed_hosts].join(', ')}. Everything else is blocked.</Fact>,
                <Fact key={`${poi.id}-production`} label={`Production domains Gnomi must never touch${of}`}>{poi.production_domains.length > 0 ? poi.production_domains.join(', ') : 'None listed.'}</Fact>,
              ];
            })}
          </div>
          {webPois(saved.pois).filter((poi) => poi.not_production).map((poi) => <p key={poi.id} className="review-note">You confirmed that {poi.name} is not a production site.</p>)}
          {webPois(saved.pois).some((poi) => poi.reset_hook_url !== null) && (
            <div className="space-y-1">
              <Check checked={reset} onChange={setReset}>
                Reset staging before the run
              </Check>
              {webPois(saved.pois).flatMap((poi) => (poi.reset_hook_url === null ? [] : [<p key={poi.id} className="break-all pl-6 text-xs text-stone-500">Gnomi sends a POST to {poi.reset_hook_url} first.</p>]))}
            </div>
          )}
          <p className="review-note">Gnomi cannot see what staging does behind the scenes. Make sure it sends email to a test inbox and takes payments in test mode.</p>
        </Section>
      </div>}

      <ActionBar>
        <Button onClick={onBack} className="mr-auto"><Icon name="back" size={16} />Back to audience</Button>
        {outcome ? <Note tone="error">{outcome.text}</Note> : <p id="review-start-hint" className="review-status">{status}</p>}
        <Button onClick={start} disabled={busy || !ready || recorder.recording !== null} aria-describedby={outcome ? undefined : 'review-start-hint'} variant="primary">
          <Icon name="play" size={16} />{busy ? 'Starting...' : 'Start run'}
        </Button>
      </ActionBar>
    </div>
  );
}

/** Whether some personas browse without a login: a segment with a share and no role, or the built-in persona with none. */
function loggedOut(config: ProjectConfig) {
  return config.audience ? config.audience.segments.some((segment) => segment.share > 0 && segment.role === null) : config.role === null;
}
