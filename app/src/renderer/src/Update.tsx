import { useState } from 'react';
import type { ComponentProps } from 'react';
import type { UpdateState } from '../../main/release.ts';
import { Icon } from './Icon.tsx';
import { Button, Card } from './ui.tsx';

/** A step with a newer release in it: the ones the banner across the app shows. */
export type Release = Extract<UpdateState, { version: string }>;

const ICONS: Record<UpdateState['status'] | 'development', ComponentProps<typeof Icon>['name']> = { development: 'leaf', checking: 'clock', current: 'check', failed: 'alert', downloading: 'spark', ready: 'spark', available: 'spark' };

/** What each step says; `version` is the one running. */
function describe(state: UpdateState | null, version: string): { title: string; detail: string } {
  switch (state?.status) {
    case 'checking': return { title: `Gnomi ${version}`, detail: 'Checking GitHub for a newer release…' };
    case 'current': return { title: `Gnomi ${version} is up to date`, detail: 'Gnomi checks once per launch, and whenever you ask here.' };
    case 'failed': return { title: `Gnomi ${version}`, detail: 'Could not reach GitHub to check for a newer release. Try again, or see the releases page.' };
    case 'downloading': return { title: `Gnomi ${state.version} is on its way`, detail: `Downloading, ${Math.round(state.percent)}% so far. You have ${version}; the update installs when you restart.` };
    case 'ready': return { title: `Gnomi ${state.version} is ready to install`, detail: `You have ${version}. Restart to update now, or it updates the next time you quit; your projects stay.` };
    case 'available': return { title: `Gnomi ${state.version} is available`, detail: `You have ${version}. Download the new version from GitHub and install it over this one; your projects stay.` };
    default: return { title: `Gnomi ${version}`, detail: 'A development build. Installed releases check GitHub for newer ones; this one does not.' };
  }
}

/** Restart, Download or Check again, whichever the step calls for; a download in progress needs nothing. */
function UpdateAction({ state, small }: { state: UpdateState | null; small?: boolean }) {
  const [restarting, setRestarting] = useState(false);
  if (!state || state.status === 'downloading') return null;
  if (state.status === 'ready') return <Button small={small} variant="primary" loading={restarting} onClick={() => { setRestarting(true); void window.gnomi.installUpdate().finally(() => setRestarting(false)); }}>Restart to update<Icon name="arrow" size={14} /></Button>;
  if (state.status === 'available') return <Button small={small} variant="primary" onClick={() => void window.gnomi.openReleases()}>Download<Icon name="arrow" size={14} /></Button>;
  return <Button small={small} loading={state.status === 'checking'} onClick={() => void window.gnomi.checkUpdate()}>{state.status === 'checking' ? 'Checking…' : state.status === 'failed' ? 'Try again' : 'Check for updates'}</Button>;
}

function UpdateRow({ state, version, small, className, children, ...rest }: ComponentProps<'div'> & { state: UpdateState | null; version: string; small?: boolean }) {
  const { title, detail } = describe(state, version);
  const status = state?.status ?? 'development';
  return (
    <div {...rest} className={['update-row', className].filter(Boolean).join(' ')} data-status={status}>
      <span className="update-badge"><Icon name={ICONS[status]} size={18} /></span>
      <div className="update-copy">
        <p className="update-title">{title}</p>
        <p>{detail}</p>
        {state?.status === 'downloading' && <div role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.percent)} className="update-meter"><span style={{ width: `${state.percent}%` }} /></div>}
      </div>
      <div className="update-actions"><UpdateAction state={state} small={small} />{children}</div>
    </div>
  );
}

/** Across the app while a newer release downloads or waits: dismissing it hides that release until the next launch. */
export function UpdateBanner({ release, version, onDismiss }: { release: Release; version: string; onDismiss(): void }) {
  return (
    <UpdateRow role="status" className="update-banner" state={release} version={version} small>
      <Button small variant="quiet" aria-label="Dismiss update notice" onClick={onDismiss}><Icon name="close" size={14} /></Button>
    </UpdateRow>
  );
}

/** The Settings card: the running version, where the check stands and the way to the releases page. */
export function UpdateCard({ state, version }: { state: UpdateState | null; version: string }) {
  return (
    <Card title="Updates">
      <UpdateRow state={state} version={version} />
      <p className="mt-4 text-xs text-stone-500">Release notes and every version: <Button variant="link" onClick={() => void window.gnomi.openReleases()}>github.com/svichas/Gnomi/releases</Button></p>
    </Card>
  );
}
