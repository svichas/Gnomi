import { useState } from 'react';
import { forSharing } from '@gnomi/simulation/report/edits.ts';
import type { RepeatSet } from '@gnomi/simulation/report/repeats.ts';
import type { Report as ReportData } from '@gnomi/simulation/types.ts';
import { REPORT_FORMATS } from '../../reports.ts';
import type { ReportFormat } from '../../reports.ts';
import { Button, inputClass, OutcomeNote, useAction } from './ui.tsx';
import { Icon } from './Icon.tsx';

/** Saves the report as a file. The file is drawn on demand, so the screen never loads the static renderer or the inlined styles. */
export function ExportReport({ report, repeats }: { report: ReportData; repeats?: RepeatSet }) {
  const [format, setFormat] = useState<ReportFormat>('html');
  const { busy, outcome, run } = useAction();
  const { shared } = forSharing(report);
  const save = () =>
    run(async () => {
      const { reportFile } = await import('./reportFile.tsx');
      const path = await window.gnomi.saveReport(format, report.run_id, await reportFile(report, format, window.gnomi.reportThumbnails, repeats));
      return path === null ? null : { ok: true, text: `Report exported to ${path}` };
    });
  return (
    <div className="report-export">
      <div className="report-export-copy"><Icon name="report" size={20} /><div><strong>Keep a copy of the findings</strong><p>{shared ? `Exports leave out ${shared.hidden} hidden and use your wording for ${shared.reworded}, and the file says so.` : 'Export the full report with its simulation records.'}</p></div></div>
      <div className="report-export-actions">
        <select
          aria-label="Export format"
          value={format}
          onChange={(e) => setFormat(e.target.value as ReportFormat)}
          disabled={busy}
          className={inputClass}
        >
          {Object.entries(REPORT_FORMATS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button variant="secondary" onClick={() => void save()} disabled={busy}>
          <Icon name="down" size={16} />
          {busy ? 'Exporting...' : 'Export report'}
        </Button>
      </div>
      <OutcomeNote outcome={outcome} />
    </div>
  );
}
