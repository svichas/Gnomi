import { useState } from 'react';
import type { SessionInfo } from '@gnomi/simulation/types.ts';
import { call } from './engine.ts';
import { Button, useAction } from './ui.tsx';

/**
 * The record, then save flow of tech.md §9.1, shared by the Project screen and a blocked persona's banner.
 * shortcut: the engine cannot be asked whether a recording is open, so a page reload mid-recording loses the panel;
 * closing the recorder's browser window recovers. Add a status query when reloads during recording turn up in practice.
 */
export function useRecorder(onSaved: (session: SessionInfo) => Promise<void>) {
  const [recording, setRecording] = useState<string | null>(null); // the role being recorded
  const { busy, outcome, run } = useAction();

  /** `before` runs first and may refuse with a sentence, such as "fix the form" or "save the project". */
  const start = (role: string, before?: () => Promise<string | null>, target_id?: string) =>
    run(async () => {
      const problem = await before?.();
      if (problem) return { ok: false, text: problem };
      await call('record_session', { role, ...(target_id ? { target_id } : {}) });
      setRecording(role);
      return null;
    });

  const save = () =>
    run(async () => {
      const session = await call('save_session', {});
      setRecording(null);
      await onSaved(session);
      return { ok: true, text: `Login saved for ${session.role}.` };
    });

  const cancel = () =>
    run(async () => {
      setRecording(null); // forgotten even if the engine no longer has the recording
      await call('cancel_recording', {});
      return null;
    });

  return { recording, busy, outcome, start, save, cancel };
}

export type Recorder = ReturnType<typeof useRecorder>;

export function RecordingPanel({ recorder }: { recorder: Recorder }) {
  if (recorder.recording === null) return null;
  return (
    <div role="region" aria-label="Recording a login" className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
      <p className="text-sm font-medium text-stone-900">Recording the login for {recorder.recording}</p>
      <p className="text-sm text-stone-700">
        A browser window opened. Log in there — SSO, MFA and CAPTCHAs are fine; Gnomi never sees your password. Then go to the page personas should
        start on and press Save login.
      </p>
      <div className="flex gap-3">
        <Button onClick={recorder.save} disabled={recorder.busy} variant="primary">
          Save login
        </Button>
        <Button onClick={recorder.cancel} disabled={recorder.busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
