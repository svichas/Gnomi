import { useContext, useState } from 'react';
import type { Report as ReportData } from '@gnomi/engine/types.ts';
import { REPORT_FORMATS } from '../../reports.ts';
import type { ReportFormat } from '../../reports.ts';
import { Note, StaticFile, secondaryButton, useAction } from './ui.tsx';

/** Saves the report as a file. The file is drawn on demand, so the screen never loads the static renderer or the inlined styles. */
export function ExportReport({ report }: { report: ReportData }) {
  const [format, setFormat] = useState<ReportFormat>('html');
  const { busy, outcome, run } = useAction();
  if (useContext(StaticFile)) return null; // the exported file has no controls
  const save = () =>
    run(async () => {
      const { reportFile } = await import('./reportFile.tsx');
      const path = await window.gnomi.saveReport(format, report.run_id, await reportFile(report, format, window.gnomi.reportThumbnails));
      return path === null ? null : { ok: true, text: `Report exported to ${path}` };
    });
  return (
    <div className="flex min-w-0 max-w-full flex-col items-end gap-2 break-words">
      <div className="flex items-center gap-2">
        <select
          aria-label="Export format"
          value={format}
          onChange={(e) => setFormat(e.target.value as ReportFormat)}
          disabled={busy}
          className="rounded-lg border border-stone-300 bg-white px-2 py-2 text-sm text-stone-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
        >
          {Object.entries(REPORT_FORMATS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void save()} disabled={busy} className={secondaryButton}>
          {busy ? 'Exporting...' : 'Export'}
        </button>
      </div>
      {outcome && <Note tone={outcome.ok ? 'ok' : 'error'}>{outcome.text}</Note>}
    </div>
  );
}
